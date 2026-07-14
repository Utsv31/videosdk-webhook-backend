const { cancelPendingRetryJobsForLead, createRetryJob } = require('../repositories/retryJobs');
const { applyCallWindow } = require('../utils/businessHours');
const logger = require('../utils/logger');

const DEFAULT_GST_SIP_CALL_FROM = '+918035017510';
const DEFAULT_GST_ROUTING_RULE_ID = 'rr_fogwqz';
const MAX_GST_TOTAL_ATTEMPTS = 3;
const GST_STANDARD_RETRY_DELAYS_MS = {
  2: 2 * 60 * 1000,
  3: 60 * 60 * 1000,
};
const GST_BUSY_ENGAGED_RETRY_DELAYS_MS = {
  2: 30 * 60 * 1000,
  3: 60 * 60 * 1000,
};

const GST_RETRYABLE_CALL_STATUSES = new Set([
  'call_not_picked',
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

function isGstConfirmed(parsed) {
  return (
    isYes(parsed.isGstRegistered) ||
    parsed.gstStatus === 'registered'
  );
}

function getGstRoutingRuleId(parsed) {
  return process.env.GST_ROUTING_RULE_ID || parsed.routingRuleId || DEFAULT_GST_ROUTING_RULE_ID;
}

function getGstSipCallFrom() {
  return process.env.GST_SIP_CALL_FROM || DEFAULT_GST_SIP_CALL_FROM;
}

function getWebhookUrl(parsed) {
  return process.env.VIDEOSDK_WEBHOOK_URL || parsed.webhookUrl;
}

function getRetryFlow(parsed) {
  if (parsed.retryFlow === 'busy-engaged') {
    return {
      name: 'busy-engaged',
      delays: GST_BUSY_ENGAGED_RETRY_DELAYS_MS,
    };
  }

  if (parsed.gstCallStatus === 'busy' && isYes(parsed.isRightBusiness) && isNo(parsed.isNeedCallback)) {
    return {
      name: 'busy-engaged',
      delays: GST_BUSY_ENGAGED_RETRY_DELAYS_MS,
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
      name: parsed.customerName || '',
      business_name: parsed.businessName || '',
      age_of_business: parsed.ageOfBusiness || parsed.businessAge || '',
      is_gst_registered: parsed.isGstRegisteredInput || '',
      webhook_url: webhookUrl,
    },
  };
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

  if (isYes(parsed.isNeedCallback)) {
    return {
      shouldRetry: false,
      reason: 'callback needed; route to sales and stop ai retries',
    };
  }

  if (isGstConfirmed(parsed)) {
    return {
      shouldRetry: false,
      reason: 'gst confirmed; route normal lead and stop ai retries',
    };
  }

  if (isYes(parsed.demoRequested)) {
    return {
      shouldRetry: false,
      reason: 'demo requested; retry skipped',
    };
  }

  if (
    parsed.gstCallStatus === 'busy' &&
    isYes(parsed.isRightBusiness) &&
    !isNo(parsed.isNeedCallback)
  ) {
    return {
      shouldRetry: false,
      reason: 'busy identity confirmed without explicit callback=no; route normal lead and stop ai retries',
    };
  }

  if (
    parsed.gstCallStatus === 'failed' &&
    isYes(parsed.isRightBusiness) &&
    !isNo(parsed.isNeedCallback)
  ) {
    return {
      shouldRetry: false,
      reason: 'failed identity confirmed without explicit callback=no; route normal lead and stop ai retries',
    };
  }

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
  const retryFlow = getRetryFlow(parsed);

  if (currentAttempt >= MAX_GST_TOTAL_ATTEMPTS || nextAttempt > MAX_GST_TOTAL_ATTEMPTS) {
    return {
      shouldRetry: false,
      reason: 'max gst retry attempts reached',
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
    reason: `${parsed.gstCallStatus} ${retryFlow.name} retry attempt ${nextAttempt}`,
    retryFlow: retryFlow.name,
    currentAttempt,
    nextAttempt,
    requestedScheduledAt,
    requestedScheduledAtIst: callWindow.requestedAtIst,
    scheduledAt: callWindow.scheduledAt,
    scheduledAtIst: callWindow.scheduledAtIst,
    businessHoursAdjusted: callWindow.adjusted,
    delayMs,
    dispatchPayload: buildGstRetryDispatchPayload(parsed, nextAttempt),
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

module.exports = {
  DEFAULT_GST_ROUTING_RULE_ID,
  MAX_GST_TOTAL_ATTEMPTS,
  GST_RETRYABLE_CALL_STATUSES,
  buildGstRetryDispatchPayload,
  getGstRetryDecision,
  scheduleGstRetryIfNeeded,
};
