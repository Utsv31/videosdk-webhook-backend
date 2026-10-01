const { cancelPendingRetryJobsForLead, createRetryJob } = require('../repositories/retryJobs');
const { applyCallWindow } = require('../utils/businessHours');
const logger = require('../utils/logger');

const DEFAULT_GST_SIP_CALL_FROM = '+918031151693';
const DEFAULT_GST_ROUTING_RULE_ID = 'rr_fogwqz';
const DEFAULT_PROBLEM_LEADS_CAMPAIGN = 'Reach_Out_Problem_Leads';
const DEFAULT_PROBLEM_LEADS_SOURCE_KEY = 'problem_leads_outreach';
const DEFAULT_PROBLEM_LEADS_ROUTING_RULE_ID = 'rr_3zadcx';
const MAX_GST_TOTAL_ATTEMPTS = 3;
const GST_STANDARD_RETRY_DELAYS_MS = {
  2: 2 * 60 * 1000,
  3: 60 * 60 * 1000,
};
const GST_CALLBACK_REQUESTED_RETRY_DELAYS_MS = {
  2: 2 * 60 * 60 * 1000,
  3: 2 * 60 * 60 * 1000,
};

const GST_RETRYABLE_CALL_STATUSES = new Set([
  'call_not_picked',
  'voicemail',
  'busy',
  'failed',
]);

const PROBLEM_LEADS_RETRYABLE_OUTCOMES = new Set([
  'no_answer',
  'call_not_picked',
  'not_picked',
  'unanswered',
  'voicemail',
  'busy',
  'failed',
]);

function asPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isYes(value) {
  return value === 'yes' || value === true;
}

function isNo(value) {
  return value === 'no' || value === false;
}

function normalizeOutcome(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isExplicitNo(value) {
  return isNo(value);
}

function hasValue(value) {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value !== 'string') {
    return Boolean(value);
  }

  const normalized = value.trim().toLowerCase();
  return Boolean(normalized) && ![
    'no',
    'not disclosed',
    'not applicable',
    'not sure',
    'none',
  ].includes(normalized);
}

function hasMeaningfulGstSignal(parsed) {
  return Boolean(
    isYes(parsed.isRightBusiness) ||
    isYes(parsed.isNeedCallback) ||
    isYes(parsed.demoRequested) ||
    isYes(parsed.invoicingAndBilling) ||
    isYes(parsed.completeAccounting) ||
    hasValue(parsed.currentInvoicingPlatform) ||
    hasValue(parsed.requirementType) ||
    hasValue(parsed.businessNature) ||
    hasValue(parsed.businessDescription),
  );
}

function isCallbackRequestedRetryPath(parsed) {
  return (
    ['busy', 'failed'].includes(parsed.gstCallStatus) &&
    isYes(parsed.isNeedCallback) &&
    !isExplicitNo(parsed.isRightBusiness)
  );
}

function getGstRoutingRuleId(parsed) {
  return process.env.GST_ROUTING_RULE_ID || parsed.routingRuleId || DEFAULT_GST_ROUTING_RULE_ID;
}

function getProblemLeadsRoutingRuleId(parsed) {
  return (
    process.env.PROBLEM_LEADS_ROUTING_RULE_ID ||
    process.env.ADHOC_ROUTING_RULE_ID ||
    parsed.routingRuleId ||
    DEFAULT_PROBLEM_LEADS_ROUTING_RULE_ID
  );
}

function getGstSipCallFrom() {
  return process.env.GST_SIP_CALL_FROM || DEFAULT_GST_SIP_CALL_FROM;
}

function getProblemLeadsSipCallFrom() {
  return (
    process.env.PROBLEM_LEADS_SIP_CALL_FROM ||
    process.env.ADHOC_SIP_CALL_FROM ||
    process.env.GST_SIP_CALL_FROM ||
    DEFAULT_GST_SIP_CALL_FROM
  );
}

function getWebhookUrl(parsed) {
  return process.env.VIDEOSDK_WEBHOOK_URL || parsed.webhookUrl;
}

function getRetryFlow(parsed) {
  if (parsed.retryFlow === 'callback-requested') {
    return {
      name: 'callback-requested',
      delays: GST_CALLBACK_REQUESTED_RETRY_DELAYS_MS,
    };
  }

  return {
    name: 'standard',
    delays: GST_STANDARD_RETRY_DELAYS_MS,
  };
}

function buildGstRetryDispatchPayload(parsed, nextAttempt) {
  const webhookUrl = getWebhookUrl(parsed);

  return {
    sipCallFrom: getGstSipCallFrom(),
    sipCallTo: parsed.phone,
    routingRuleId: getGstRoutingRuleId(parsed),
    metadata: {
      refrensLeadId: parsed.refrensLeadId,
      originalCallId: parsed.callId,
      retryAttempt: nextAttempt,
      retryFlow: getRetryFlow(parsed).name,
      sourceKey: parsed.sourceKey || '',
      name: parsed.customerName || '',
      business_name: parsed.businessName || '',
      age_of_business: parsed.ageOfBusiness || parsed.businessAge || '',
      webhook_url: webhookUrl,
    },
  };
}

function buildProblemLeadsRetryDispatchPayload(parsed, nextAttempt) {
  const webhookUrl = getWebhookUrl(parsed);

  return {
    sipCallFrom: getProblemLeadsSipCallFrom(),
    sipCallTo: parsed.phone,
    routingRuleId: getProblemLeadsRoutingRuleId(parsed),
    metadata: {
      refrensLeadId: parsed.refrensLeadId,
      originalCallId: parsed.callId,
      retryAttempt: nextAttempt,
      retryFlow: getRetryFlow(parsed).name,
      source: 'retry',
      sourceKey: parsed.sourceKey || DEFAULT_PROBLEM_LEADS_SOURCE_KEY,
      campaign: parsed.campaign || DEFAULT_PROBLEM_LEADS_CAMPAIGN,
      agentType: parsed.agentType || 'adhoc',
      name: parsed.customerName || '',
      business_name: parsed.businessName || '',
      webhook_url: webhookUrl,
    },
  };
}

function isAdhocPositiveSignal(parsed) {
  const positiveOutcomes = new Set([
    'Interested',
    'Callback Requested',
    'Need Time',
  ]);

  return (
    positiveOutcomes.has(parsed.callOutcome) ||
    parsed.offerInterest === 'Interested' ||
    parsed.salesCallbackRequired === true
  );
}

function isProblemLeadsOutreach(parsed) {
  return (
    parsed.agentType === 'adhoc' &&
    (
      parsed.campaign === DEFAULT_PROBLEM_LEADS_CAMPAIGN ||
      parsed.sourceKey === DEFAULT_PROBLEM_LEADS_SOURCE_KEY
    )
  );
}

function hasProblemLeadsStopSignal(parsed) {
  return Boolean(
    isAdhocPositiveSignal(parsed) ||
    isYes(parsed.isRightBusiness) ||
    isYes(parsed.isNeedCallback) ||
    isYes(parsed.demoRequested)
  );
}

function getGstRetryDecision(parsed) {
  if (parsed.agentType !== 'gst') {
    return {
      shouldRetry: false,
      reason: 'not gst agent',
    };
  }

  if (!GST_RETRYABLE_CALL_STATUSES.has(parsed.gstCallStatus)) {
    return {
      shouldRetry: false,
      reason: `non-retryable gst call status: ${parsed.gstCallStatus || 'missing'}`,
    };
  }

  if (isYes(parsed.demoRequested)) {
    return {
      shouldRetry: false,
      reason: 'demo requested; retry skipped',
    };
  }

  if (isCallbackRequestedRetryPath(parsed)) {
    return buildRetryDecision(parsed, getRetryFlow({
      ...parsed,
      retryFlow: 'callback-requested',
    }));
  }

  if (parsed.retryFlow === 'callback-requested') {
    return buildRetryDecision(parsed, getRetryFlow(parsed));
  }

  if (parsed.gstCallStatus === 'busy' && hasMeaningfulGstSignal(parsed)) {
    return {
      shouldRetry: false,
      reason: 'busy call has populated summary fields; stop ai retries',
    };
  }

  if (parsed.gstCallStatus === 'failed' && hasMeaningfulGstSignal(parsed)) {
    return {
      shouldRetry: false,
      reason: 'failed call has populated summary fields; stop ai retries',
    };
  }

  return buildRetryDecision(parsed, getRetryFlow(parsed));
}

function getProblemLeadsRetryDecision(parsed) {
  if (!isProblemLeadsOutreach(parsed)) {
    return {
      shouldRetry: false,
      reason: 'not problem leads outreach',
    };
  }

  if (hasProblemLeadsStopSignal(parsed)) {
    return {
      shouldRetry: false,
      reason: 'problem leads call has positive/callback/identity signal; stop ai retries',
    };
  }

  const outcome = normalizeOutcome(parsed.callOutcome);

  if (!PROBLEM_LEADS_RETRYABLE_OUTCOMES.has(outcome)) {
    return {
      shouldRetry: false,
      reason: `non-retryable problem leads call outcome: ${parsed.callOutcome || 'missing'}`,
    };
  }

  return buildRetryDecision(parsed, getRetryFlow(parsed), {
    maxAttempts: MAX_GST_TOTAL_ATTEMPTS,
    dispatchPayloadBuilder: buildProblemLeadsRetryDispatchPayload,
    statusLabel: parsed.callOutcome || outcome || 'unknown',
  });
}

function buildRetryDecision(parsed, retryFlow, options = {}) {
  const {
    maxAttempts = MAX_GST_TOTAL_ATTEMPTS,
    dispatchPayloadBuilder = buildGstRetryDispatchPayload,
    statusLabel = parsed.gstCallStatus,
  } = options;

  if (!parsed.refrensLeadId) {
    return {
      shouldRetry: false,
      reason: 'missing refrensLeadId',
    };
  }

  if (!parsed.phone) {
    return {
      shouldRetry: false,
      reason: 'missing sipCallTo',
    };
  }

  if (!getWebhookUrl(parsed)) {
    return {
      shouldRetry: false,
      reason: 'missing webhook_url',
    };
  }

  const currentAttempt = asPositiveInteger(parsed.retryAttempt, 1);
  const nextAttempt = currentAttempt + 1;

  if (currentAttempt >= maxAttempts || nextAttempt > maxAttempts) {
    return {
      shouldRetry: false,
      reason: 'max retry attempts reached',
      currentAttempt,
    };
  }

  const delayMs = retryFlow.delays[nextAttempt];

  if (!delayMs) {
    return {
      shouldRetry: false,
      reason: `no delay configured for retry attempt ${nextAttempt}`,
      currentAttempt,
      nextAttempt,
    };
  }

  const requestedScheduledAt = new Date(Date.now() + delayMs);
  const callWindow = applyCallWindow(requestedScheduledAt);

  return {
    shouldRetry: true,
    reason: `${statusLabel} ${retryFlow.name} retry attempt ${nextAttempt}`,
    retryFlow: retryFlow.name,
    currentAttempt,
    nextAttempt,
    requestedScheduledAt,
    requestedScheduledAtIst: callWindow.requestedAtIst,
    scheduledAt: callWindow.scheduledAt,
    scheduledAtIst: callWindow.scheduledAtIst,
    businessHoursAdjusted: callWindow.adjusted,
    delayMs,
    dispatchPayload: dispatchPayloadBuilder(parsed, nextAttempt),
  };
}

async function scheduleGstRetryIfNeeded(eventId, parsed) {
  const decision = getGstRetryDecision(parsed);

  if (!decision.shouldRetry) {
    const cancelledJobs = await cancelPendingRetryJobsForLead(parsed.refrensLeadId, decision.reason);

    logger.info('GST retry not scheduled', {
      callId: parsed.callId,
      agentId: parsed.agentId,
      reason: decision.reason,
      currentAttempt: decision.currentAttempt,
      cancelledJobs,
    });
    return {
      ...decision,
      cancelledJobs,
    };
  }

  const job = await createRetryJob({
    eventId,
    parsed,
    nextAttempt: decision.nextAttempt,
    scheduledAt: decision.scheduledAt,
    scheduledAtIst: decision.scheduledAtIst,
    requestedScheduledAt: decision.requestedScheduledAt,
    requestedScheduledAtIst: decision.requestedScheduledAtIst,
    businessHoursAdjusted: decision.businessHoursAdjusted,
    reason: decision.reason,
    retryFlow: decision.retryFlow,
    dispatchPayload: decision.dispatchPayload,
  });

  logger.info('GST retry scheduled', {
    callId: parsed.callId,
    refrensLeadId: parsed.refrensLeadId,
    nextAttempt: decision.nextAttempt,
    scheduledAt: decision.scheduledAt.toISOString(),
    scheduledAtIst: decision.scheduledAtIst,
    businessHoursAdjusted: decision.businessHoursAdjusted,
    retryJobId: job?._id?.toString(),
  });

  return {
    ...decision,
    job,
  };
}

async function scheduleProblemLeadsRetryIfNeeded(eventId, parsed) {
  const decision = getProblemLeadsRetryDecision(parsed);

  if (!decision.shouldRetry) {
    const cancelledJobs = await cancelPendingRetryJobsForLead(parsed.refrensLeadId, decision.reason);

    logger.info('Problem leads retry not scheduled', {
      callId: parsed.callId,
      agentId: parsed.agentId,
      reason: decision.reason,
      currentAttempt: decision.currentAttempt,
      cancelledJobs,
    });
    return {
      ...decision,
      cancelledJobs,
    };
  }

  const job = await createRetryJob({
    eventId,
    parsed,
    nextAttempt: decision.nextAttempt,
    scheduledAt: decision.scheduledAt,
    scheduledAtIst: decision.scheduledAtIst,
    requestedScheduledAt: decision.requestedScheduledAt,
    requestedScheduledAtIst: decision.requestedScheduledAtIst,
    businessHoursAdjusted: decision.businessHoursAdjusted,
    reason: decision.reason,
    retryFlow: decision.retryFlow,
    dispatchPayload: decision.dispatchPayload,
  });

  logger.info('Problem leads retry scheduled', {
    callId: parsed.callId,
    refrensLeadId: parsed.refrensLeadId,
    nextAttempt: decision.nextAttempt,
    scheduledAt: decision.scheduledAt.toISOString(),
    scheduledAtIst: decision.scheduledAtIst,
    businessHoursAdjusted: decision.businessHoursAdjusted,
    retryJobId: job?._id?.toString(),
  });

  return {
    ...decision,
    job,
  };
}

module.exports = {
  DEFAULT_GST_ROUTING_RULE_ID,
  DEFAULT_PROBLEM_LEADS_CAMPAIGN,
  DEFAULT_PROBLEM_LEADS_SOURCE_KEY,
  MAX_GST_TOTAL_ATTEMPTS,
  GST_RETRYABLE_CALL_STATUSES,
  PROBLEM_LEADS_RETRYABLE_OUTCOMES,
  buildGstRetryDispatchPayload,
  buildProblemLeadsRetryDispatchPayload,
  getGstRetryDecision,
  getProblemLeadsRetryDecision,
  scheduleGstRetryIfNeeded,
  scheduleProblemLeadsRetryIfNeeded,
};
