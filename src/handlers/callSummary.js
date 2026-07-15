const {
  createLeadInCrm,
  getLeadInCrm,
  patchLeadInCrm,
  isLeadNotFoundError,
} = require('./crm');
const {
  markEventParsed,
  markLeadSkipped,
  markLeadCreated,
  markLeadPatched,
  markLeadFailed,
  markRetryDecision,
} = require('../repositories/callEvents');
const { scheduleGstRetryIfNeeded } = require('./gstRetry');
const { adhoc, gst, parsePayload } = require('../agents');
const { normalizeRefrensLeadId } = require('../agents/common');
const logger = require('../utils/logger');

const AGENT_TYPES = {
  ADHOC: adhoc.type,
  GST: gst.type,
};

const PATCH_ONLY_AGENT_TYPES = new Set([
  AGENT_TYPES.ADHOC,
  AGENT_TYPES.GST,
]);

function unwrapWebhookBody(body) {
  return body;
}

function isCallSummaryPayload(body) {
  const payload = unwrapWebhookBody(body);
  return Boolean(payload && payload['call-summary']);
}

function getConfiguredGstAgentIds() {
  return gst.getAgentIds();
}

function getGstSipCallFrom() {
  return gst.getDefaultCallerPhone();
}

function parseCallSummary(body) {
  return parsePayload(unwrapWebhookBody(body));
}

function isPositiveCall(parsed) {
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

async function processCallSummary(body, options = {}) {
  const parsed = parseCallSummary(body);
  const isPatchOnlyAgent = PATCH_ONLY_AGENT_TYPES.has(parsed.agentType);
  const isPositive = isPositiveCall(parsed);
  const shouldCreateLead = !isPatchOnlyAgent && isPositive;
  const { eventId } = options;

  logger.info('Processing call summary', {
    agentType: parsed.agentType,
    callId: parsed.callId,
    callOutcome: parsed.callOutcome,
    gstCallStatus: parsed.gstCallStatus,
    interestLevel: parsed.interestLevel,
    offerInterest: parsed.offerInterest,
    salesCallbackRequired: parsed.salesCallbackRequired,
    refrensLeadId: parsed.refrensLeadId,
    isPositive,
    shouldCreateLead,
  });

  await markEventParsed(eventId, parsed, isPositive);

  async function handleRetryDecision() {
    if (parsed.agentType !== AGENT_TYPES.GST) {
      return null;
    }

    const retryDecision = await scheduleGstRetryIfNeeded(eventId, parsed);
    await markRetryDecision(eventId, retryDecision);
    return retryDecision;
  }

  if (parsed.refrensLeadId) {
    try {
      await getLeadInCrm(parsed.refrensLeadId);
      const result = await patchLeadInCrm(parsed.refrensLeadId, parsed);

      await markLeadPatched(eventId, {
        leadId: parsed.refrensLeadId,
        requestPayload: result.requestPayload,
        result,
      });

      await handleRetryDecision();

      return result;
    } catch (error) {
      if (!isLeadNotFoundError(error)) {
        await markLeadFailed(eventId, {
          leadId: parsed.refrensLeadId,
          requestPayload: error.requestPayload,
          error,
        });

        throw error;
      }

      logger.warn('Refrens lead id from VideoSDK payload was not found', {
        callId: parsed.callId,
        refrensLeadId: parsed.refrensLeadId,
        agentType: parsed.agentType,
      });

      if (isPatchOnlyAgent) {
        await markLeadSkipped(eventId, `${parsed.agentType} refrens lead not found; patch skipped`);

        return {
          success: true,
          skipped: true,
          reason: `${parsed.agentType} refrens lead not found; patch skipped`,
          callId: parsed.callId,
          refrensLeadId: parsed.refrensLeadId,
        };
      }

      if (!shouldCreateLead) {
        await markLeadSkipped(eventId, 'refrens lead not found and non-positive call');

        return {
          success: true,
          skipped: true,
          reason: 'refrens lead not found and non-positive call',
          callId: parsed.callId,
          refrensLeadId: parsed.refrensLeadId,
        };
      }
    }
  }

  if (isPatchOnlyAgent) {
    logger.warn('Skipping CRM action because refrensLeadId was not provided for patch-only agent', {
      callId: parsed.callId,
      agentId: parsed.agentId,
      agentType: parsed.agentType,
    });

    await markLeadSkipped(eventId, `${parsed.agentType} call missing refrensLeadId; patch skipped`);

    return {
      success: true,
      skipped: true,
      reason: `${parsed.agentType} call missing refrensLeadId; patch skipped`,
      callId: parsed.callId,
    };
  }

  if (!shouldCreateLead) {
    logger.info('Skipping CRM lead creation for non-positive call', {
      callId: parsed.callId,
      callOutcome: parsed.callOutcome,
      interestLevel: parsed.interestLevel,
    });

    await markLeadSkipped(eventId, 'non-positive call');

    return {
      success: true,
      skipped: true,
      reason: 'non-positive call',
      callId: parsed.callId,
    };
  }

  try {
    const result = await createLeadInCrm(parsed);

    await markLeadCreated(eventId, {
      externalId: result.externalId,
      requestPayload: result.requestPayload,
      result,
    });

    return result;
  } catch (error) {
    await markLeadFailed(eventId, {
      externalId: error.externalId,
      leadId: error.leadId,
      requestPayload: error.requestPayload,
      error,
    });

    throw error;
  }
}

module.exports = {
  AGENT_TYPES,
  DEFAULT_GST_AGENT_ID: gst.DEFAULT_GST_AGENT_ID,
  DEFAULT_GST_SIP_CALL_FROM: gst.DEFAULT_GST_SIP_CALL_FROM,
  getConfiguredGstAgentIds,
  getGstSipCallFrom,
  PATCH_ONLY_AGENT_TYPES,
  isCallSummaryPayload,
  unwrapWebhookBody,
  normalizeRefrensLeadId,
  parseCallSummary,
  isPositiveCall,
  processCallSummary,
};
