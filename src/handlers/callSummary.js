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
} = require('../repositories/callEvents');
const logger = require('../utils/logger');

function isCallSummaryPayload(body) {
  return Boolean(body && body['call-summary']);
}

function normalizeRefrensLeadId(value) {
  if (!value) {
    return null;
  }

  const leadId = String(value).trim();
  return /^[a-f\d]{24}$/i.test(leadId) ? leadId : null;
}

function getRefrensLeadId(customerData, roomData, body) {
  return normalizeRefrensLeadId(
    customerData.refrensLeadId ||
    customerData.crm_lead_id ||
    customerData.leadId ||
    customerData.metaData?.refrensLeadId ||
    customerData.metaData?.crm_lead_id ||
    roomData.refrensLeadId ||
    body?.data?.metaData?.refrensLeadId ||
    body?.data?.metaData?.crm_lead_id,
  );
}

function parseCallSummary(body) {
  const summary = body['call-summary'] || {};
  const customerData = body['customer-data'] || {};
  const roomData = body['room-data'] || {};

  return {
    callId: customerData.callId,
    customerName: customerData.name,
    phone: customerData.sipCallTo,
    callerPhone: customerData.sipCallFrom,
    campaign: customerData.campaign || summary.campaign,

    callOutcome: summary.call_outcome,
    interestLevel: summary.interest_level,
    offerIntroduced: summary.offer_introduced,
    offerInterest: summary.offer_interest,
    salesCallbackRequired: summary.sales_callback_required === true,
    callbackTime: summary.callback_time,
    customerSentiment: summary.customer_sentiment,
    originalObjection: summary.original_objection,
    currentSolution: summary.current_solution,
    currentNeed: summary.current_need,
    importantNotes: summary.important_notes,
    recommendedAction: summary.recommended_action,
    callSummaryText: summary.call_summary,

    agentId: roomData.agentId,
    meetingId: roomData['meeting-id'],
    sessionId: roomData['session-id'],
    refrensLeadId: getRefrensLeadId(customerData, roomData, body),
  };
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
  const shouldCreateLead = isPositiveCall(parsed);
  const { eventId } = options;

  logger.info('Processing call summary', {
    callId: parsed.callId,
    callOutcome: parsed.callOutcome,
    interestLevel: parsed.interestLevel,
    offerInterest: parsed.offerInterest,
    salesCallbackRequired: parsed.salesCallbackRequired,
    refrensLeadId: parsed.refrensLeadId,
    shouldCreateLead,
  });

  await markEventParsed(eventId, parsed, shouldCreateLead);

  if (parsed.refrensLeadId) {
    try {
      await getLeadInCrm(parsed.refrensLeadId);
      const result = await patchLeadInCrm(parsed.refrensLeadId, parsed);

      await markLeadPatched(eventId, {
        leadId: parsed.refrensLeadId,
        requestPayload: result.requestPayload,
        result,
      });

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

      logger.warn('Refrens lead id from VideoSDK payload was not found; falling back to create path', {
        callId: parsed.callId,
        refrensLeadId: parsed.refrensLeadId,
      });

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
  isCallSummaryPayload,
  normalizeRefrensLeadId,
  parseCallSummary,
  isPositiveCall,
  processCallSummary,
};
