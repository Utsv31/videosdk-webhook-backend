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

const AGENT_TYPES = {
  ADHOC: 'adhoc',
  GST: 'gst',
};

const AGENT_IDS_BY_TYPE = {
  [AGENT_TYPES.GST]: new Set([
    'ag_n8irvh',
  ]),
};

const PATCH_ONLY_AGENT_TYPES = new Set([
  AGENT_TYPES.ADHOC,
  AGENT_TYPES.GST,
]);

function unwrapWebhookBody(body) {
  return body?.body?.['call-summary'] ? body.body : body;
}

function isCallSummaryPayload(body) {
  const payload = unwrapWebhookBody(body);
  return Boolean(payload && payload['call-summary']);
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

function hasGstSummaryShape(summary) {
  return Boolean(
    summary.call_status ||
    summary.gst_status ||
    summary.current_invoicing_platform ||
    summary.requirement_type ||
    summary.lead_priority,
  );
}

function getAgentType(summary, roomData) {
  if (roomData.agentId && AGENT_IDS_BY_TYPE[AGENT_TYPES.GST].has(roomData.agentId)) {
    return AGENT_TYPES.GST;
  }

  return hasGstSummaryShape(summary) ? AGENT_TYPES.GST : AGENT_TYPES.ADHOC;
}

function normalizeEnumValue(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

function normalizeYesNo(value) {
  const normalized = normalizeEnumValue(value);
  return normalized === 'true' ? 'yes' : normalized === 'false' ? 'no' : normalized;
}

function parseCallSummary(body) {
  const payload = unwrapWebhookBody(body) || {};
  const summary = payload['call-summary'] || {};
  const customerData = payload['customer-data'] || {};
  const roomData = payload['room-data'] || {};

  return {
    callId: customerData.callId,
    customerName: customerData.name,
    businessName: customerData.business_name,
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
    callSummaryText: summary.call_summary || summary.summary,

    agentType: getAgentType(summary, roomData),
    gstCallStatus: normalizeEnumValue(summary.call_status),
    gstStatus: normalizeEnumValue(summary.gst_status || summary.is_gst_registred),
    isRightBusiness: normalizeYesNo(summary.is_right_business),
    isNeedCallback: normalizeYesNo(summary.is_need_callback || summary.is_callback_needed),
    invoicingAndBilling: normalizeYesNo(summary.invoicing_and_billing),
    completeAccounting: normalizeYesNo(summary.complete_accounting),
    demoRequested: normalizeYesNo(summary.demo_requested),
    currentInvoicingPlatform: normalizeEnumValue(summary.current_invoicing_platform),
    requirementType: normalizeEnumValue(summary.requirement_type),
    businessNature: normalizeEnumValue(summary.business_nature),
    leadPriority: normalizeEnumValue(summary.lead_priority),
    businessAge: summary.business_age,
    businessDescription: summary.business_description,

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
  AGENT_IDS_BY_TYPE,
  PATCH_ONLY_AGENT_TYPES,
  isCallSummaryPayload,
  unwrapWebhookBody,
  normalizeRefrensLeadId,
  parseCallSummary,
  isPositiveCall,
  processCallSummary,
};
