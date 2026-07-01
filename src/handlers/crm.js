const axios = require('axios');
const logger = require('../utils/logger');

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

async function createLeadInCrm(parsed) {
  const apiKey = process.env.REFRENS_API_KEY;
  const baseUrl = (process.env.REFRENS_API_BASE_URL || 'https://api.refrens.com').replace(/\/$/, '');
  const businessSlug = process.env.REFRENS_BUSINESS_SLUG || 'crm-lead-create';

  if (!apiKey) {
    throw new Error('REFRENS_API_KEY is not configured');
  }

  const url = `${baseUrl}/api/v1/businesses/${encodeURIComponent(businessSlug)}/leads`;
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
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
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

module.exports = {
  buildLeadDetails,
  buildExternalId,
  buildCreateLeadPayload,
  createLeadInCrm,
};
