const axios = require('axios');
const { readSecret } = require('../utils/secrets');

function getMetabaseConfig() {
  const baseUrl = (process.env.METABASE_URL || '').replace(/\/$/, '');
  const apiKey = readSecret('METABASE_API_KEY', {
    defaultFileNames: [
      'metabase_api_key',
      'metabase_api_key.txt',
    ],
  });
  const sessionToken = readSecret('METABASE_SESSION_TOKEN', {
    defaultFileNames: [
      'metabase_session_token',
      'metabase_session_token.txt',
    ],
  });

  if (!baseUrl) {
    throw new Error('METABASE_URL is not configured');
  }

  if (!apiKey && !sessionToken) {
    throw new Error('METABASE_API_KEY or METABASE_SESSION_TOKEN is required');
  }

  return {
    baseUrl,
    headers: {
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      ...(sessionToken ? { 'X-Metabase-Session': sessionToken } : {}),
      'Content-Type': 'application/json',
    },
  };
}

async function fetchQuestionRows(questionId, parameters = {}) {
  if (!questionId) {
    throw new Error('Metabase question id is required');
  }

  const config = getMetabaseConfig();
  const url = `${config.baseUrl}/api/card/${encodeURIComponent(questionId)}/query/json`;
  const response = await axios.post(url, parameters, {
    headers: config.headers,
    timeout: 60000,
  });

  return {
    status: response.status,
    url,
    rows: Array.isArray(response.data) ? response.data : [],
    rawResponse: response.data,
  };
}

module.exports = {
  fetchQuestionRows,
  getMetabaseConfig,
};
