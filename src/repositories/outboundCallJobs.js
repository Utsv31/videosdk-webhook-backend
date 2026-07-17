const { ObjectId } = require('mongodb');
const { getOutboundCallJobsCollection, isMongoConfigured } = require('../services/mongo');

const ACTIVE_JOB_STATUSES = [
  'scheduled',
  'dispatching',
  'dispatched',
  'webhook_started',
];
const TERMINAL_JOB_STATUSES = [
  'summary_received',
  'webhook_timeout',
  'dispatch_failed',
  'pre_dispatch_check_failed',
  'skipped',
  'skipped_before_dispatch',
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
    active: true,
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
    active: true,
    status: 'scheduled',
    terminalStatus: null,
    closeReason: null,
    closedAt: null,
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
      callHangupReceived: false,
      callHangupAt: null,
      callHangupEventId: null,
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
    active: false,
    status: 'skipped',
    terminalStatus: 'skipped',
    closeReason: skipReason,
    closedAt: now,
    skipReason,
    matchedSkipTags: matchedSkipTags || [],
    createdAt: now,
    updatedAt: now,
  });

  return collection.findOne({ _id: result.insertedId });
}

async function markOutboundJobSkippedBeforeDispatch(jobId, { reason, matchedSkipTags, crmLead }) {
  if (!jobId || !isMongoConfigured()) {
    return;
  }

  const collection = await getOutboundCallJobsCollection();
  await collection.updateOne(
    { _id: toObjectId(jobId) },
    {
      $set: {
        active: false,
        status: 'skipped_before_dispatch',
        terminalStatus: 'skipped_before_dispatch',
        closeReason: reason,
        skipReason: reason,
        matchedSkipTags: matchedSkipTags || [],
        crmLeadSnapshot: crmLead || null,
        skippedAt: new Date(),
        closedAt: new Date(),
        updatedAt: new Date(),
      },
    },
  );
}

async function markOutboundJobPreDispatchCheckFailed(jobId, error) {
  if (!jobId || !isMongoConfigured()) {
    return;
  }

  const collection = await getOutboundCallJobsCollection();
  const now = new Date();
  await collection.updateOne(
    { _id: toObjectId(jobId) },
    {
      $set: {
        active: false,
        status: 'pre_dispatch_check_failed',
        terminalStatus: 'pre_dispatch_check_failed',
        closeReason: 'live Refrens pre-dispatch check failed',
        failedAt: now,
        closedAt: now,
        lastError: error?.message || 'Unknown Refrens pre-dispatch check error',
        preDispatchCheckStatusCode: error?.response?.status || null,
        preDispatchCheckResponse: error?.response?.data || null,
        updatedAt: now,
      },
    },
  );
}

async function claimNextOutboundCallJob() {
  if (!isMongoConfigured()) {
    return null;
  }

  const collection = await getOutboundCallJobsCollection();
  const now = new Date();
  const result = await collection.findOneAndUpdate(
    {
      active: true,
      status: 'scheduled',
      scheduledAt: { $lte: now },
    },
    {
      $set: {
        active: true,
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
        active: true,
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
        active: false,
        status: 'dispatch_failed',
        terminalStatus: 'dispatch_failed',
        closeReason: 'VideoSDK SIP dispatch failed',
        failedAt: new Date(),
        closedAt: new Date(),
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
  const eventObjectId = isValidObjectId(eventId) ? toObjectId(eventId) : null;

  if (webhookType === 'call-hangup') {
    await collection.updateOne(
      { _id: toObjectId(outboundJobId) },
      {
        $set: {
          callId: callId || null,
          roomId: roomId || null,
          updatedAt: now,
          'webhook.callHangupReceived': true,
          'webhook.callHangupAt': now,
          'webhook.callHangupEventId': eventObjectId,
        },
      },
    );
    return collection.findOne({ _id: toObjectId(outboundJobId) });
  }

  if (!['call-started', 'call-summary'].includes(webhookType)) {
    return collection.findOne({ _id: toObjectId(outboundJobId) });
  }

  const isSummary = webhookType === 'call-summary';
  const update = {
    $set: {
      callId: callId || null,
      roomId: roomId || null,
      updatedAt: now,
      ...(isSummary
        ? {
          active: false,
          status: 'summary_received',
          terminalStatus: 'summary_received',
          closeReason: 'summary webhook received',
          closedAt: now,
          'webhook.callSummaryReceived': true,
          'webhook.callSummaryAt': now,
          'webhook.callSummaryEventId': eventObjectId,
        }
        : {
          active: true,
          status: 'webhook_started',
          'webhook.callStartedReceived': true,
          'webhook.callStartedAt': now,
          'webhook.callStartedEventId': eventObjectId,
        }),
    },
  };

  await collection.updateOne(
    {
      _id: toObjectId(outboundJobId),
      ...(isSummary ? {} : { status: { $nin: TERMINAL_JOB_STATUSES } }),
    },
    update,
  );
  return collection.findOne({ _id: toObjectId(outboundJobId) });
}

async function findWebhookTimedOutJobs(limit = 10) {
  if (!isMongoConfigured()) {
    return [];
  }

  const collection = await getOutboundCallJobsCollection();
  return collection.find({
    status: 'dispatched',
    active: true,
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
        active: true,
        terminalStatus: null,
        closeReason: null,
        closedAt: null,
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
        active: false,
        status: 'webhook_timeout',
        terminalStatus: 'webhook_timeout',
        closeReason: 'No VideoSDK webhook received before deadline',
        timedOutAt: new Date(),
        closedAt: new Date(),
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
  TERMINAL_JOB_STATUSES,
  claimNextOutboundCallJob,
  createOutboundCallJob,
  createSkippedOutboundCallJob,
  findActiveJobForLead,
  findWebhookTimedOutJobs,
  markOutboundJobDispatched,
  markOutboundJobDispatchFailed,
  markOutboundJobPreDispatchCheckFailed,
  markOutboundJobSkippedBeforeDispatch,
  markOutboundJobWebhookReceived,
  markOutboundJobWebhookTimeout,
  requeueOutboundJobAfterWebhookTimeout,
};
