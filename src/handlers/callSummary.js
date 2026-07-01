const { createLeadInCrm } = require('./crm');
const {
  markEventParsed,
  markLeadSkipped,
  markLeadCreated,
  markLeadFailed,
} = require('../repositories/callEvents');
const logger = require('../utils/logger');

function isCallSummaryPayload(body) {
  return Boolean(body && body['call-summary']);
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
    shouldCreateLead,
  });

  await markEventParsed(eventId, parsed, shouldCreateLead);

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
      requestPayload: error.requestPayload,
      error,
    });

    throw error;
  }
}

module.exports = {
  isCallSummaryPayload,
  parseCallSummary,
  isPositiveCall,
  processCallSummary,
};
