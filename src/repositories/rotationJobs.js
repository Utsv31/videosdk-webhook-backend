const { ObjectId } = require('mongodb');
const { getDb } = require('../services/mongo');
const { WORKFLOW } = require('../utils/rotationPlan');

let readyDb;
async function collections() {
  const db = await getDb();
  if (!db) throw Object.assign(new Error('MongoDB is required for rotational calling'), { statusCode: 503 });
  const jobs = db.collection('rotational_call_jobs');
  if (readyDb !== db) {
    await jobs.createIndex({ dedupeKey: 1 }, { unique: true });
    await jobs.createIndex({ planId: 1, status: 1, scheduledAt: 1 });
    await jobs.createIndex({ callId: 1 });
    readyDb = db;
  }
  return { jobs, days: db.collection('rotational_call_days'), locks: db.collection('rotational_call_locks') };
}

async function ensureRotationPlan(plan) {
  const { jobs, days } = await collections();
  let saved;
  try {
    saved = await days.findOneAndUpdate({ _id: plan._id }, {
      $setOnInsert: { ...plan, status: 'active', createdAt: new Date() },
    }, { upsert: true, returnDocument: 'after' });
  } catch (error) {
    if (error.code !== 11000) throw error;
    saved = await days.findOne({ _id: plan._id });
  }
  if (saved.status === 'active') {
    await jobs.bulkWrite(saved.jobs.map(j => ({ updateOne: {
      filter: { dedupeKey: j.dedupeKey },
      update: { $setOnInsert: { ...j, status: 'scheduled', dispatchAttempts: 0, createdAt: new Date(), updatedAt: new Date() } },
      upsert: true,
    } })));
  }
  return saved;
}

async function acquireRotationLock(now, gapMinutes) {
  const { locks } = await collections();
  try {
    await locks.updateOne({ _id: WORKFLOW }, { $setOnInsert: { lockedUntil: new Date(0), nextAllowedAt: new Date(0) } }, { upsert: true });
  } catch (error) { if (error.code !== 11000) throw error; }
  const token = new ObjectId().toString();
  return locks.findOneAndUpdate({ _id: WORKFLOW, lockedUntil: { $lte: now }, nextAllowedAt: { $lte: now } }, {
    $set: { token, lockedUntil: new Date(now.getTime() + 60000), nextAllowedAt: new Date(now.getTime() + gapMinutes * 60000) },
  }, { returnDocument: 'after' });
}

async function releaseRotationLock(token) {
  const { locks } = await collections();
  await locks.updateOne({ _id: WORKFLOW, token }, { $set: { lockedUntil: new Date(0) } });
}

async function claimRotationJob(planId, now) {
  const { jobs, days } = await collections();
  const day = await days.findOne({ _id: planId, status: 'active' });
  if (!day) return null;
  return jobs.findOneAndUpdate({ planId, status: 'scheduled', scheduledAt: { $lte: now }, expiresAt: { $gt: now } }, {
    $set: { status: 'dispatching', lockedAt: now, updatedAt: now }, $inc: { dispatchAttempts: 1 },
  }, { sort: { scheduledAt: 1 }, returnDocument: 'after' });
}

async function sweepRotationJobs(now) {
  const { jobs } = await collections();
  await jobs.updateMany({ status: 'scheduled', expiresAt: { $lte: now } }, {
    $set: { status: 'expired', closeReason: 'Scheduled slot missed; no catch-up call', updatedAt: now },
  });
  await jobs.updateMany({ status: 'dispatching', lockedAt: { $lte: new Date(now.getTime() - 60000) } }, {
    $set: { status: 'dispatch_unknown', closeReason: 'Dispatch interrupted; reconcile with VideoSDK before any new attempt', updatedAt: now },
  });
  await jobs.updateMany({ status: 'dispatched', webhookDeadlineAt: { $lte: now } }, {
    $set: { status: 'summary_timeout', closeReason: 'Summary missing; no additional retry call', updatedAt: now },
  });
}

async function prepareRotationDispatch(id, payload) {
  const { jobs } = await collections();
  await jobs.updateOne({ _id: id, status: 'dispatching' }, { $set: { dispatchPayload: payload, updatedAt: new Date() } });
}

async function cancelRotationJob(id, reason) {
  const { jobs } = await collections();
  await jobs.updateOne({ _id: id, status: 'dispatching' }, { $set: { status: 'cancelled', closeReason: reason, updatedAt: new Date() } });
}

async function markRotationResult(id, { result, error }) {
  const { jobs } = await collections();
  const callId = result?.data?.data?.id || result?.data?.id || result?.data?.callId || null;
  const status = result && callId ? 'dispatched' : error?.response?.status >= 400 && error.response.status < 500 ? 'dispatch_failed' : 'dispatch_unknown';
  const now = new Date();
  await jobs.updateOne({ _id: id }, { $set: {
    dispatchResult: result || error?.response?.data || null,
    dispatchStatusCode: result?.status || error?.response?.status || null,
    lastError: error?.message || (callId ? null : 'Provider did not return a call ID; no automatic retry'),
    ...(callId ? { callId } : {}), dispatchedAt: result ? now : null,
    webhookDeadlineAt: new Date(now.getTime() + 6 * 60000), updatedAt: now,
  } });
  // A fast summary can arrive before the dispatch response is persisted.
  await jobs.updateOne({ _id: id, status: 'dispatching' }, { $set: { status } });
  return { status, callId };
}

async function recordRotationWebhook({ jobId, callId, roomId, webhookType, eventId, body }) {
  const { jobs } = await collections();
  const query = jobId && /^[a-f\d]{24}$/i.test(jobId) ? { _id: new ObjectId(jobId) } : callId ? { callId } : null;
  if (!query || !['call-started', 'call-hangup', 'call-summary'].includes(webhookType)) return null;
  const job = await jobs.findOne(query);
  if (!job || (job.callId && callId && job.callId !== callId)) return null;
  const now = new Date();
  const update = {
    [`webhooks.${webhookType}`]: { receivedAt: now, eventId, callId, roomId }, updatedAt: now,
    ...(callId ? { callId } : {}), ...(roomId ? { roomId } : {}),
  };
  if (webhookType === 'call-summary') {
    Object.assign(update, { status: 'completed', summary: body['call-summary'], completedAt: now });
  }
  await jobs.updateOne({ _id: job._id }, { $set: update });
  return job;
}

async function getRotationStatus(date) {
  const { jobs, days } = await collections();
  const planId = `${WORKFLOW}:${date}`;
  const plan = await days.findOne({ _id: planId }, { projection: { jobs: 0 } });
  const rows = await jobs.find({ planId }).sort({ slot: 1 }).toArray();
  return { plan, jobs: rows, counts: rows.reduce((a,j) => { a[j.status] = (a[j.status] || 0) + 1; return a; }, {}) };
}

async function stopRotationDay(date) {
  const { jobs, days } = await collections();
  const planId = `${WORKFLOW}:${date}`;
  // Upsert a tombstone even before a day's plan exists so a later tick cannot restart it.
  await days.updateOne({ _id: planId }, { $set: { status: 'stopped', stoppedAt: new Date() } }, { upsert: true });
  return jobs.updateMany({ planId, status: 'scheduled' }, {
    $set: { status: 'cancelled', closeReason: 'Stopped by operator', updatedAt: new Date() },
  });
}

module.exports = { acquireRotationLock, cancelRotationJob, claimRotationJob, ensureRotationPlan, getRotationStatus, markRotationResult, prepareRotationDispatch, recordRotationWebhook, releaseRotationLock, stopRotationDay, sweepRotationJobs };
