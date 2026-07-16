const { ObjectId } = require('mongodb');
const { getOutboundCallJobsCollection, isMongoConfigured } = require('../services/mongo');

const ACTIVE_JOB_STATUSES = [
  'scheduled',
  'dispatching',
  'dispatched',
  'webhook_started',
];

function toObjectId(id) {
  return typeof id === 'string' ? new ObjectId(id) : id;
}

function isValidObjectId(id) {
  return id && ObjectId.isValid(id);
}

async function findActiveJobForLead({ sourceKey, refrensLeadId }) {
  if (!isMongoConfigured() || !refrensLeadId) {
    return null;
  }

  const collection = await getOutboundCallJobsCollection();
  return collection.findOne({
    sourceKey,
    refrensLeadId,
    status: { $in: ACTIVE_JOB_STATUSES },
  });
}

async function createOutboundCallJob({
  runId,
  sourceKey,
  questionId,
  lead,
  rawRow,
  scheduledAt,
  scheduledAtIst,
  businessHoursAdjusted,
}) {
  if (!isMongoConfigured()) {
    return null;
  }

  const collection = await getOutboundCallJobsCollection();
  const now = new Date();
  const dedupeKey = `${sourceKey}:${runId}:${lead.leadId}`;
  const document = {
    dedupeKey,
    runId: runId ? toObjectId(runId) : null,
    sourceKey,
    questionId,
    refrensLeadId: lead.leadId,
    name: lead.name || '',
    businessName: lead.businessName || '',
    phone: lead.phone || '',
    email: lead.email || '',
    stage: lead.stage || null,
    tags: lead.tags || [],
    rawRow,
    status: 'scheduled',
    skipReason: null,
    matchedSkipTags: [],
    scheduledAt,
    scheduledAtIst,
    businessHoursAdjusted: businessHoursAdjusted === true,
    dispatchAttempts: 0,
    maxDispatchAttempts: Number.parseInt(process.env.OUTBOUND_CALL_MAX_DISPATCH_ATTEMPTS, 10) || 2,
    dispatchPayload: null,
    dispatchResult: null,
    dispatchStatusCode: null,
    lastError: null,
    callId: null,
    roomId: null,
    outboundJobId: null,
    webhook: {
      callStartedReceived: false,
      callStartedAt: null,
      callStartedEventId: null,
      callSummaryReceived: false,
      callSummaryAt: null,
      callSummaryEventId: null,
      deadlineAt: null,
      timeoutCount: 0,
    },
    createdAt: now,
    updatedAt: now,
  };

  const result = await collection.insertOne(document);
  return collection.findOne({ _id: result.insertedId });
}

async function createSkippedOutboundCallJob({
  runId,
  sourceKey,
  questionId,
  lead,
  rawRow,
  skipReason,
  matchedSkipTags,
}) {
  if (!isMongoConfigured()) {
    return null;
  }

  const collection = await getOutboundCallJobsCollection();
  const now = new Date();
  const result = await collection.insertOne({
    dedupeKey: `${sourceKey}:${runId}:${lead.leadId || lead.phone || now.getTime()}:skipped`,
    runId: runId ? toObjectId(runId) : null,
    sourceKey,
    questionId,
    refrensLeadId: lead.leadId || null,
    name: lead.name || '',
    businessName: lead.businessName || '',
    phone: lead.phone || '',
    email: lead.email || '',
    stage: lead.stage || null,
    tags: lead.tags || [],
    rawRow,
    status: 'skipped',
    skipReason,
    matchedSkipTags: matchedSkipTags || [],
    createdAt: now,
    updatedAt: now,
  });

  return collection.findOne({ _id: result.insertedId });
}

async function claimNextOutboundCallJob() {
  if (!isMongoConfigured()) {
    return null;
  }

  const collection = await getOutboundCallJobsCollection();
  const now = new Date();
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
    },
    {
      sort: { scheduledAt: 1, createdAt: 1 },
      returnDocument: 'after',
    },
  );

  return result?.value || result;
}

async function markOutboundJobDispatched(jobId, { payload, result, webhookDeadlineAt }) {
  if (!jobId || !isMongoConfigured()) {
    return;
  }

  const collection = await getOutboundCallJobsCollection();
  await collection.updateOne(
    { _id: toObjectId(jobId) },
    {
      $set: {
        status: 'dispatched',
        outboundJobId: jobId.toString(),
        dispatchPayload: payload,
        dispatchResult: result,
        dispatchStatusCode: result?.status || null,
        lastError: null,
        dispatchedAt: new Date(),
        'webhook.deadlineAt': webhookDeadlineAt,
        updatedAt: new Date(),
      },
      $inc: {
        dispatchAttempts: 1,
      },
    },
  );
}

async function markOutboundJobDispatchFailed(jobId, error) {
  if (!jobId || !isMongoConfigured()) {
    return;
  }

  const collection = await getOutboundCallJobsCollection();
  await collection.updateOne(
    { _id: toObjectId(jobId) },
    {
      $set: {
        status: 'dispatch_failed',
        failedAt: new Date(),
        lastError: error?.message || 'Unknown VideoSDK dispatch error',
        dispatchResult: error?.response?.data || null,
        dispatchStatusCode: error?.response?.status || null,
        updatedAt: new Date(),
      },
      $inc: {
        dispatchAttempts: 1,
      },
    },
  );
}

async function markOutboundJobWebhookReceived({ outboundJobId, callId, roomId, webhookType, eventId }) {
  if (!isValidObjectId(outboundJobId) || !isMongoConfigured()) {
    return null;
  }

  const collection = await getOutboundCallJobsCollection();
  const now = new Date();
  const isSummary = webhookType === 'call-summary';
  const update = {
    $set: {
      callId: callId || null,
      roomId: roomId || null,
      updatedAt: now,
      ...(isSummary
        ? {
          status: 'summary_received',
          'webhook.callSummaryReceived': true,
          'webhook.callSummaryAt': now,
          'webhook.callSummaryEventId': isValidObjectId(eventId) ? toObjectId(eventId) : null,
        }
        : {
          status: 'webhook_started',
          'webhook.callStartedReceived': true,
          'webhook.callStartedAt': now,
          'webhook.callStartedEventId': isValidObjectId(eventId) ? toObjectId(eventId) : null,
        }),
    },
  };

  await collection.updateOne({ _id: toObjectId(outboundJobId) }, update);
  return collection.findOne({ _id: toObjectId(outboundJobId) });
}

async function findWebhookTimedOutJobs(limit = 10) {
  if (!isMongoConfigured()) {
    return [];
  }

  const collection = await getOutboundCallJobsCollection();
  return collection.find({
    status: 'dispatched',
    'webhook.callStartedReceived': false,
    'webhook.callSummaryReceived': false,
    'webhook.deadlineAt': { $lte: new Date() },
  }).sort({ 'webhook.deadlineAt': 1 }).limit(limit).toArray();
}

async function requeueOutboundJobAfterWebhookTimeout(job, scheduledAt, scheduledAtIst) {
  if (!job?._id || !isMongoConfigured()) {
    return;
  }

  const collection = await getOutboundCallJobsCollection();
  await collection.updateOne(
    { _id: job._id },
    {
      $set: {
        status: 'scheduled',
        scheduledAt,
        scheduledAtIst,
        lastError: 'No VideoSDK webhook received before deadline; requeued dispatch',
        updatedAt: new Date(),
        'webhook.deadlineAt': null,
      },
      $inc: {
        'webhook.timeoutCount': 1,
      },
    },
  );
}

async function markOutboundJobWebhookTimeout(job) {
  if (!job?._id || !isMongoConfigured()) {
    return;
  }

  const collection = await getOutboundCallJobsCollection();
  await collection.updateOne(
    { _id: job._id },
    {
      $set: {
        status: 'webhook_timeout',
        timedOutAt: new Date(),
        lastError: 'No VideoSDK webhook received before deadline',
        updatedAt: new Date(),
      },
      $inc: {
        'webhook.timeoutCount': 1,
      },
    },
  );
}

module.exports = {
  ACTIVE_JOB_STATUSES,
  claimNextOutboundCallJob,
  createOutboundCallJob,
  createSkippedOutboundCallJob,
  findActiveJobForLead,
  findWebhookTimedOutJobs,
  markOutboundJobDispatched,
  markOutboundJobDispatchFailed,
  markOutboundJobWebhookReceived,
  markOutboundJobWebhookTimeout,
  requeueOutboundJobAfterWebhookTimeout,
};
