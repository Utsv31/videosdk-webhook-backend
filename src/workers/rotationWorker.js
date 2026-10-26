const repo = require('../repositories/rotationJobs');
const { buildRotationPlan, configFingerprint, getRotationConfig, istDate, SOURCE_KEY, validateRotationConfig } = require('../utils/rotationPlan');
const { dispatchSipCall, getVideoSdkAuthToken } = require('../services/videosdk');
const { isWithinCallWindow } = require('../utils/businessHours');
const { readSecret } = require('../utils/secrets');
const logger = require('../utils/logger');

let timer;
let running = false;

function buildRotationDispatchPayload(job, config) {
  return {
    sipCallFrom: job.sipCallFrom, sipCallTo: job.phone, routingRuleId: job.routingRuleId,
    metadata: {
      ...config.metadata,
      name: job.recipientName, sourceKey: SOURCE_KEY, rotationJobId: job._id.toString(),
      rotationDateIst: job.dateIst, rotationSlot: job.slot,
      webhook_url: process.env.VIDEOSDK_WEBHOOK_URL,
      // Never link the test workflow to production CRM or cohort retry jobs.
      refrensLeadId: null, outboundJobId: null, retryAttempt: null,
    },
  };
}

async function processRotationCallJobs() {
  if (running) return;
  running = true;
  let lock;
  try {
    const config = getRotationConfig();
    if (config.enabled !== true) return;
    validateRotationConfig(config, { live: true });
    if (!getVideoSdkAuthToken() || !readSecret('JOBS_API_TOKEN', { defaultFileNames: ['jobs_api_token', 'jobs_api_token.txt'] })) {
      throw new Error('VideoSDK authentication and JOBS_API_TOKEN are required for live rotation');
    }
    if (!/^https:\/\//.test(process.env.VIDEOSDK_WEBHOOK_URL || '')) throw new Error('Set an HTTPS VIDEOSDK_WEBHOOK_URL');
    const now = new Date();
    await repo.sweepRotationJobs(now);
    const desired = buildRotationPlan(config, istDate(now));
    if (now < desired.startsAt || now >= desired.endsAt || !isWithinCallWindow(now)) return;
    const plan = await repo.ensureRotationPlan(desired);
    if (plan.status !== 'active') return;
    if (plan.fingerprint !== configFingerprint(config)) {
      throw new Error('Rotation config changed after today was planned; existing calls will not dispatch');
    }
    lock = await repo.acquireRotationLock(now, config.minimumGapMinutes);
    if (!lock) return;
    const job = await repo.claimRotationJob(plan._id, new Date());
    if (!job) return;
    // No stale slot can become a catch-up call after slow database work.
    if (!isWithinCallWindow() || new Date() >= job.expiresAt || new Date() >= plan.endsAt) {
      await repo.cancelRotationJob(job._id, 'Call window or slot expired before dispatch');
      return;
    }
    const payload = buildRotationDispatchPayload(job, config);
    await repo.prepareRotationDispatch(job._id, payload);
    let result;
    try {
      result = await dispatchSipCall(payload);
    } catch (error) {
      await repo.markRotationResult(job._id, { error });
      return;
    }
    const recorded = await repo.markRotationResult(job._id, { result });
    logger.info('Rotational dispatch response recorded', { rotationJobId: job._id.toString(), slot: job.slot, dateIst: job.dateIst, status: recorded.status, statusCode: result.status });
  } catch (error) {
    logger.error('Rotational call worker failed', { message: error.message });
  } finally {
    if (lock) await repo.releaseRotationLock(lock.token).catch(error => logger.error('Rotation lock release failed', { message: error.message }));
    running = false;
  }
}

function startRotationWorker() {
  if (timer) return timer;
  timer = setInterval(processRotationCallJobs, 30000);
  timer.unref?.();
  setTimeout(processRotationCallJobs, 10000).unref?.();
  return timer;
}

module.exports = { buildRotationDispatchPayload, processRotationCallJobs, startRotationWorker };
