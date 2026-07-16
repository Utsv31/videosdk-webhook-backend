const axios = require('axios');

function getMetabaseConfig() {
  const baseUrl = (process.env.METABASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.METABASE_API_KEY;
  const sessionToken = process.env.METABASE_SESSION_TOKEN;

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
