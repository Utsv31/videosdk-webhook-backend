const axios = require('axios');
const logger = require('../utils/logger');

const GST_PATCH_CONFIG = {
  tags: {
    identityConfirmed: 'Identity Confirmed',
    gstConfirmed: 'GST Confirmed',
    aiDemoRequested: 'AI Demo Requested',
    salesCallback: 'Sales Person callback',
  },
  stages: {
    identityConfirmed: '1.e AI Contact - Identity Confirmed',
    salesCallback: '1.g AI Contact - Sales Person Callback',
  },
};

function getCrmConfig() {
  const apiKey = process.env.REFRENS_API_KEY;
  const baseUrl = (process.env.REFRENS_API_BASE_URL || 'https://api.refrens.com').replace(/\/$/, '');
  const businessSlug = process.env.REFRENS_BUSINESS_SLUG || 'crm-lead-create';

  if (!apiKey) {
    throw new Error('REFRENS_API_KEY is not configured');
  }

  return {
    apiKey,
    baseUrl,
    businessSlug,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };
}

function getLeadsUrl({ baseUrl, businessSlug }) {
  return `${baseUrl}/api/v1/businesses/${encodeURIComponent(businessSlug)}/leads`;
}

function getLeadUrl(config, leadId) {
  return `${getLeadsUrl(config)}/${encodeURIComponent(leadId)}`;
}

function buildLeadDetails(parsed) {
  return [
    parsed.callSummaryText && `Call summary: ${parsed.callSummaryText}`,
    parsed.importantNotes && `Important notes: ${parsed.importantNotes}`,
    parsed.recommendedAction && `Recommended action: ${parsed.recommendedAction}`,
    parsed.currentNeed && `Current need: ${parsed.currentNeed}`,
    parsed.currentSolution && `Current solution: ${parsed.currentSolution}`,
    parsed.originalObjection && `Original objection: ${parsed.originalObjection}`,
    parsed.callbackTime && `Callback time: ${parsed.callbackTime}`,
    parsed.customerSentiment && `Customer sentiment: ${parsed.customerSentiment}`,
    parsed.offerInterest && `Offer interest: ${parsed.offerInterest}`,
    parsed.campaign && `Campaign: ${parsed.campaign}`,
    parsed.callId && `VideoSDK callId: ${parsed.callId}`,
    parsed.meetingId && `VideoSDK meetingId: ${parsed.meetingId}`,
    parsed.agentId && `VideoSDK agentId: ${parsed.agentId}`,
  ].filter(Boolean).join('\n');
}

function buildExternalId(parsed) {
  const stableId = parsed.callId || parsed.meetingId || parsed.sessionId;

  if (!stableId) {
    throw new Error('Cannot create Refrens lead without a stable callId, meetingId, or sessionId');
  }

  return `videosdk-${stableId}`.slice(0, 128);
}

function buildClientRequestId(parsed) {
  const stableId = parsed.callId || parsed.meetingId || parsed.sessionId || parsed.refrensLeadId;

  return `videosdk-${stableId || 'unknown'}-summary-note`.slice(0, 128);
}

function trimNoteEntry(value) {
  return value.slice(0, 500);
}

function isYes(value) {
  return value === 'yes' || value === true;
}

function isGstConfirmed(parsed) {
  return (
    isYes(parsed.isGstRegistered) ||
    isYes(parsed.isGstRegisteredInput) ||
    parsed.gstStatus === 'registered'
  );
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildInternalNoteEntries(parsed) {
  const genericNotes = [
    parsed.callSummaryText && `VideoSDK call summary: ${parsed.callSummaryText}`,
    [
      parsed.callOutcome && `Outcome: ${parsed.callOutcome}`,
      parsed.gstCallStatus && `Call status: ${parsed.gstCallStatus}`,
      parsed.interestLevel && `Interest: ${parsed.interestLevel}`,
      parsed.offerInterest && `Offer interest: ${parsed.offerInterest}`,
      parsed.salesCallbackRequired && 'Sales callback required',
      parsed.isRightBusiness && `Right business: ${parsed.isRightBusiness}`,
      parsed.isGstRegistered && `GST registered: ${parsed.isGstRegistered}`,
      parsed.isNeedCallback && `Callback needed: ${parsed.isNeedCallback}`,
      parsed.demoRequested && `Demo requested: ${parsed.demoRequested}`,
      parsed.callbackTime && `Callback time: ${parsed.callbackTime}`,
      parsed.retryAttempt && `Retry attempt: ${parsed.retryAttempt}`,
      parsed.retryFlow && `Retry flow: ${parsed.retryFlow}`,
    ].filter(Boolean).join('. '),
    parsed.gstStatus && `GST status: ${parsed.gstStatus}`,
    parsed.currentInvoicingPlatform && `Current invoicing platform: ${parsed.currentInvoicingPlatform}`,
    parsed.requirementType && `Requirement type: ${parsed.requirementType}`,
    parsed.businessNature && `Business nature: ${parsed.businessNature}`,
    parsed.leadPriority && `Lead priority: ${parsed.leadPriority}`,
    parsed.businessName && `Business name: ${parsed.businessName}`,
    parsed.businessDescription && `Business description: ${parsed.businessDescription}`,
    parsed.importantNotes && `Important notes: ${parsed.importantNotes}`,
    parsed.recommendedAction && `Recommended action: ${parsed.recommendedAction}`,
    parsed.callId && `VideoSDK callId: ${parsed.callId}`,
  ];

  return genericNotes.filter(Boolean).map(trimNoteEntry);
}

function buildGstTags(parsed) {
  return uniqueValues([
    isYes(parsed.isRightBusiness) && GST_PATCH_CONFIG.tags.identityConfirmed,
    isGstConfirmed(parsed) && GST_PATCH_CONFIG.tags.gstConfirmed,
    isYes(parsed.demoRequested) && GST_PATCH_CONFIG.tags.aiDemoRequested,
    parsed.gstCallStatus === 'busy' && isYes(parsed.isNeedCallback) && GST_PATCH_CONFIG.tags.salesCallback,
  ]);
}

function getGstStage(parsed) {
  if (parsed.gstCallStatus === 'busy' && isYes(parsed.isNeedCallback)) {
    return GST_PATCH_CONFIG.stages.salesCallback;
  }

  if (isYes(parsed.isRightBusiness) || isGstConfirmed(parsed)) {
    return GST_PATCH_CONFIG.stages.identityConfirmed;
  }

  return null;
}

function buildGstPatchLeadPayload(parsed) {
  const pipeline = process.env.REFRENS_DEFAULT_PIPELINE || 'Sales Pipeline';
  const stage = getGstStage(parsed);
  const tagsAdd = buildGstTags(parsed);
  const noteEntries = buildInternalNoteEntries(parsed);
  const payload = {
    addInternalNotes: {
      body: noteEntries.length ? noteEntries : ['GST VideoSDK call summary received.'],
      clientRequestId: buildClientRequestId(parsed),
    },
  };

  if (stage) {
    payload.pipeline = pipeline;
    payload.stage = stage;
  }

  if (tagsAdd.length) {
    payload.tagsAdd = tagsAdd;
  }

  return payload;
}

function buildCreateLeadPayload(parsed) {
  const fallbackName = `VideoSDK Lead ${parsed.callId || parsed.meetingId || 'Unknown'}`;
  const customerName = parsed.customerName || fallbackName;
  const contactName = parsed.customerName || fallbackName;
  const pipeline = process.env.REFRENS_DEFAULT_PIPELINE || 'Sales Pipeline';
  const stage = process.env.REFRENS_DEFAULT_STAGE || 'Contacted';

  return {
    externalId: buildExternalId(parsed),
    customer: {
      name: customerName,
      phone: '',
    },
    contact: {
      name: contactName,
      phone: parsed.phone || '',
    },
    subject: `VideoSDK positive call - ${parsed.callOutcome || 'Unknown outcome'}`,
    details: buildLeadDetails(parsed),
    pipeline,
    stage,
    leadSource: 'Other',
    tags: [],
  };
}

function buildPatchLeadPayload(parsed) {
  if (parsed.agentType === 'gst') {
    return buildGstPatchLeadPayload(parsed);
  }

  const pipeline = process.env.REFRENS_DEFAULT_PIPELINE || 'Sales Pipeline';
  const stage = process.env.REFRENS_DEFAULT_STAGE || 'Contacted';
  const noteEntries = buildInternalNoteEntries(parsed);

  return {
    pipeline,
    stage,
    addInternalNotes: {
      body: noteEntries.length ? noteEntries : ['VideoSDK call summary received.'],
      clientRequestId: buildClientRequestId(parsed),
    },
  };
}

async function createLeadInCrm(parsed) {
  const config = getCrmConfig();
  const url = getLeadsUrl(config);
  const payload = buildCreateLeadPayload(parsed);

  logger.info('Creating Refrens CRM lead from positive VideoSDK call', {
    callId: parsed.callId,
    url,
    externalId: payload.externalId,
    pipeline: payload.pipeline,
    stage: payload.stage,
    callOutcome: parsed.callOutcome,
  });

  try {
    const response = await axios.post(url, payload, {
      headers: config.headers,
      timeout: 15000,
    });

    return {
      success: true,
      provider: 'refrens',
      action: 'create-lead',
      status: response.status,
      externalId: payload.externalId,
      requestPayload: payload,
      data: response.data,
    };
  } catch (error) {
    error.action = 'create-lead';
    error.externalId = payload.externalId;
    error.requestPayload = payload;

    logger.error('Refrens CRM lead creation failed', {
      callId: parsed.callId,
      status: error.response?.status,
      response: error.response?.data,
      message: error.message,
    });
    throw error;
  }
}

async function getLeadInCrm(leadId) {
  const config = getCrmConfig();
  const url = getLeadUrl(config, leadId);

  logger.info('Checking Refrens CRM lead before patch', {
    leadId,
    url,
  });

  try {
    const response = await axios.get(url, {
      headers: config.headers,
      timeout: 15000,
    });

    return {
      success: true,
      provider: 'refrens',
      action: 'get-lead',
      status: response.status,
      leadId,
      data: response.data,
    };
  } catch (error) {
    error.action = 'get-lead';
    error.leadId = leadId;

    logger.error('Refrens CRM lead lookup failed', {
      leadId,
      status: error.response?.status,
      response: error.response?.data,
      message: error.message,
    });
    throw error;
  }
}

async function patchLeadInCrm(leadId, parsed) {
  const config = getCrmConfig();
  const url = getLeadUrl(config, leadId);
  const payload = buildPatchLeadPayload(parsed);

  logger.info('Patching existing Refrens CRM lead from VideoSDK call', {
    callId: parsed.callId,
    leadId,
    url,
    pipeline: payload.pipeline,
    stage: payload.stage,
    tagsAdd: payload.tagsAdd,
    callOutcome: parsed.callOutcome,
    gstCallStatus: parsed.gstCallStatus,
  });

  try {
    const response = await axios.patch(url, payload, {
      headers: config.headers,
      timeout: 15000,
    });

    return {
      success: true,
      provider: 'refrens',
      action: 'patch-lead',
      status: response.status,
      leadId,
      requestPayload: payload,
      data: response.data,
    };
  } catch (error) {
    error.action = 'patch-lead';
    error.leadId = leadId;
    error.requestPayload = payload;

    logger.error('Refrens CRM lead patch failed', {
      callId: parsed.callId,
      leadId,
      status: error.response?.status,
      response: error.response?.data,
      message: error.message,
    });
    throw error;
  }
}

function isLeadNotFoundError(error) {
  const responseCode = error?.response?.data?.data?.error?.code || error?.response?.data?.code;

  return error?.response?.status === 404 || responseCode === 'LEAD_NOT_FOUND';
}

module.exports = {
  buildLeadDetails,
  buildExternalId,
  buildCreateLeadPayload,
  buildPatchLeadPayload,
  buildGstPatchLeadPayload,
  GST_PATCH_CONFIG,
  createLeadInCrm,
  getLeadInCrm,
  patchLeadInCrm,
  isLeadNotFoundError,
};
