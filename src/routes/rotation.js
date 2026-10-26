const express = require('express');
const { readSecret } = require('../utils/secrets');
const { buildRotationPlan, configError, getRotationConfig, istDate, validateRotationConfig } = require('../utils/rotationPlan');
const { ensureRotationPlan, getRotationStatus, stopRotationDay } = require('../repositories/rotationJobs');

const router = express.Router();
router.use((req, res, next) => {
  const token = readSecret('JOBS_API_TOKEN', { defaultFileNames: ['jobs_api_token', 'jobs_api_token.txt'] });
  if (!token) return res.status(503).json({ success: false, error: 'JOBS_API_TOKEN must be configured' });
  if (req.get('x-jobs-api-token') !== token && req.get('authorization') !== `Bearer ${token}`) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  return next();
});

const handle = fn => async (req, res, next) => {
  try { return res.json({ success: true, ...await fn(req) }); }
  catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: error.message });
    return next(error);
  }
};

router.get('/preview', handle(async req => ({
  dryRun: true, plan: buildRotationPlan(getRotationConfig(), req.query.date || istDate()),
})));

router.post('/run', handle(async req => {
  if (req.body?.dryRun !== undefined && typeof req.body.dryRun !== 'boolean') throw configError('dryRun must be a boolean');
  const dryRun = req.body?.dryRun !== false;
  const date = req.body?.date || istDate();
  const config = getRotationConfig();
  const plan = buildRotationPlan(config, date);
  if (dryRun) return { dryRun, plan };
  validateRotationConfig(config, { live: true });
  if (date !== istDate()) throw configError('Live run can only queue today in Asia/Kolkata');
  return { dryRun, plan: await ensureRotationPlan(plan) };
}));

router.get('/status', handle(async req => {
  const date = req.query.date || istDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw configError('date must use YYYY-MM-DD');
  return getRotationStatus(date);
}));

router.post('/stop', handle(async req => {
  const date = req.body?.date || istDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw configError('date must use YYYY-MM-DD');
  const result = await stopRotationDay(date);
  return { dateIst: date, cancelled: result.modifiedCount, note: 'Calls already submitted to VideoSDK cannot be recalled here.' };
}));

module.exports = router;
