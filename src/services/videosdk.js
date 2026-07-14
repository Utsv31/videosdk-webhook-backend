const axios = require('axios');
const logger = require('../utils/logger');

function getVideoSdkConfig() {
  const authToken = process.env.VIDEOSDK_AUTH_TOKEN;
  const baseUrl = (process.env.VIDEOSDK_API_BASE_URL || 'https://api.videosdk.live').replace(/\/$/, '');

  if (!authToken) {
    throw new Error('VIDEOSDK_AUTH_TOKEN is not configured');
  }

  return {
    baseUrl,
    headers: {
      authorization: authToken,
      'Content-Type': 'application/json',
    },
  };
}

async function dispatchSipCall(payload) {
  const config = getVideoSdkConfig();
  const url = `${config.baseUrl}/v2/sip/call`;

  logger.info('Dispatching VideoSDK SIP retry call', {
    url,
    sipCallFrom: payload.sipCallFrom,
    sipCallTo: payload.sipCallTo,
    routingRuleId: payload.routingRuleId,
    retryAttempt: payload.metadata?.retryAttempt,
    originalCallId: payload.metadata?.originalCallId,
  });

  try {
    const response = await axios.post(url, payload, {
      headers: config.headers,
      timeout: 15000,
    });

    return {
      success: true,
      provider: 'videosdk',
      action: 'dispatch-sip-call',
      status: response.status,
      requestPayload: payload,
      data: response.data,
    };
  } catch (error) {
    error.action = 'dispatch-sip-call';
    error.requestPayload = payload;

    logger.error('VideoSDK SIP retry dispatch failed', {
      status: error.response?.status,
      response: error.response?.data,
      message: error.message,
      sipCallTo: payload.sipCallTo,
      retryAttempt: payload.metadata?.retryAttempt,
    });

    throw error;
  }
}

module.exports = {
  dispatchSipCall,
  getVideoSdkConfig,
};
