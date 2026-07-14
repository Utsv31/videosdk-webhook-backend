const { ObjectId } = require('mongodb');
const { getRetryJobsCollection, isMongoConfigured } = require('../services/mongo');
const logger = require('../utils/logger');

function buildRetryDedupeKey({ agentType, leadId, callId, nextAttempt }) {
  const stableLeadKey = leadId || callId || 'unknown';
  return `${agentType || 'unknown'}:${stableLeadKey}:retry:${nextAttempt}`;
}

async function createRetryJob({
  eventId,
  parsed,
  nextAttempt,
  scheduledAt,
  scheduledAtIst,
  requestedScheduledAt,
  requestedScheduledAtIst,
  businessHoursAdjusted,
  reason,
  retryFlow,
  dispatchPayload,
}) {
  if (!isMongoConfigured()) {
    logger.warn('MongoDB is not configured; retry job was not persisted', {
      callId: parsed.callId,
      nextAttempt,
    });
    return null;
  }

  const collection = await getRetryJobsCollection();
  const now = new Date();
  const dedupeKey = buildRetryDedupeKey({
    agentType: parsed.agentType,
    leadId: parsed.refrensLeadId,
    callId: parsed.callId,
    nextAttempt,
  });

  await collection.updateOne(
    { dedupeKey },
    {
      $setOnInsert: {
        dedupeKey,
        sourceEventId: eventId ? new ObjectId(eventId) : null,
        callId: parsed.callId,
        refrensLeadId: parsed.refrensLeadId || null,
        agentType: parsed.agentType,
        agentId: parsed.agentId || null,
        previousCallStatus: parsed.gstCallStatus || null,
        retryAttempt: nextAttempt,
        retryFlow: retryFlow || null,
        reason,
        status: 'scheduled',
        dispatchAttempts: 0,
        requestedScheduledAt: requestedScheduledAt || scheduledAt,
        requestedScheduledAtIst: requestedScheduledAtIst || null,
        scheduledAt,
        scheduledAtIst: scheduledAtIst || null,
        businessHoursAdjusted: businessHoursAdjusted === true,
        dispatchPayload,
        dispatchResult: null,
        lastError: null,
        createdAt: now,
      },
      $set: {
        updatedAt: now,
      },
    },
    { upsert: true },
  );

  return collection.findOne({ dedupeKey });
}

async function claimDueRetryJobs(limit = 5) {
  if (!isMongoConfigured()) {
    return [];
  }

  const collection = await getRetryJobsCollection();
  const now = new Date();
  const jobs = [];

  for (let index = 0; index < limit; index += 1) {
    const result = await collection.findOneAndUpdate(
      {
        status: 'scheduled',
        scheduledAt: { $lte: now },
      },
      {
        $set: {
          status: 'dispatching',
          lockedAt: now,
          updatedAt: now,
        },
        $inc: {
          dispatchAttempts: 1,
        },
      },
      {
        sort: { scheduledAt: 1 },
        returnDocument: 'after',
      },
    );

    const job = result?.value || result;

    if (!job) {
      break;
    }

    jobs.push(job);
  }

  return jobs;
}

async function markRetryJobDispatched(jobId, result) {
  if (!jobId || !isMongoConfigured()) {
    return;
  }

  const collection = await getRetryJobsCollection();
  await collection.updateOne(
    { _id: new ObjectId(jobId) },
    {
      $set: {
        status: 'dispatched',
        dispatchedAt: new Date(),
        dispatchResult: result,
        lastError: null,
        updatedAt: new Date(),
      },
    },
  );
}

async function markRetryJobFailed(jobId, error) {
  if (!jobId || !isMongoConfigured()) {
    return;
  }

  const collection = await getRetryJobsCollection();
  await collection.updateOne(
    { _id: new ObjectId(jobId) },
    {
      $set: {
        status: 'failed',
        failedAt: new Date(),
        lastError: error?.message || 'Unknown VideoSDK dispatch error',
        dispatchResult: error?.response?.data || null,
        statusCode: error?.response?.status || null,
        updatedAt: new Date(),
      },
    },
  );
}

async function markRetryJobRescheduled(jobId, { scheduledAt, scheduledAtIst, reason }) {
  if (!jobId || !isMongoConfigured()) {
    return;
  }

  const collection = await getRetryJobsCollection();
  await collection.updateOne(
    { _id: new ObjectId(jobId) },
    {
      $set: {
        status: 'scheduled',
        scheduledAt,
        scheduledAtIst: scheduledAtIst || null,
        businessHoursAdjusted: true,
        rescheduleReason: reason,
        lockedAt: null,
        updatedAt: new Date(),
      },
    },
  );
}

async function cancelPendingRetryJobsForLead(refrensLeadId, reason) {
  if (!refrensLeadId || !isMongoConfigured()) {
    return 0;
  }

  const collection = await getRetryJobsCollection();
  const result = await collection.updateMany(
    {
      refrensLeadId,
      status: 'scheduled',
    },
    {
      $set: {
        status: 'cancelled',
        cancelReason: reason,
        cancelledAt: new Date(),
        updatedAt: new Date(),
      },
    },
  );

  return result.modifiedCount || 0;
}

module.exports = {
  buildRetryDedupeKey,
  cancelPendingRetryJobsForLead,
  createRetryJob,
  claimDueRetryJobs,
  markRetryJobDispatched,
  markRetryJobFailed,
  markRetryJobRescheduled,
};
