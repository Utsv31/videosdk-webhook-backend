const express = require('express');
const { runGstUnassignedMetabaseImport } = require('../handlers/metabaseGstUnassigned');
const { readSecret } = require('../utils/secrets');

const router = express.Router();

function isAuthorized(req) {
  const token = readSecret('JOBS_API_TOKEN', {
    defaultFileNames: [
      'jobs_api_token',
      'jobs_api_token.txt',
    ],
  });

  if (!token) {
    return true;
  }

  const headerToken = req.get('x-jobs-api-token');
  const authHeader = req.get('authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;

  return headerToken === token || bearerToken === token;
}

router.post('/metabase/gst-unassigned/run', async (req, res, next) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
    });
  }

  try {
    const limit = Number.parseInt(req.body?.limit, 10);
    const result = await runGstUnassignedMetabaseImport({
      requestedBy: req.ip,
      limit: Number.isInteger(limit) && limit > 0 ? limit : null,
      parameters: req.body?.parameters || {},
    });

    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
