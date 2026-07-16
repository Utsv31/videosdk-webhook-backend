const {
  claimNextOutboundCallJob,
  findWebhookTimedOutJobs,
  markOutboundJobDispatched,
  markOutboundJobDispatchFailed,
  markOutboundJobWebhookTimeout,
  requeueOutboundJobAfterWebhookTimeout,
} = require('../repositories/outboundCallJobs');
const { dispatchSipCall } = require('../services/videosdk');
const { applyCallWindow, isWithinCallWindow } = require('../utils/businessHours');
const logger = require('../utils/logger');

const DEFAULT_OUTBOUND_WORKER_INTERVAL_MS = 2000;
const DEFAULT_WEBHOOK_TIMEOUT_MS = 6 * 60 * 1000;
const DEFAULT_GST_SIP_CALL_FROM = '+918035017510';
const DEFAULT_GST_ROUTING_RULE_ID = 'rr_fogwqz';

let outboundWorkerTimer = null;
let outboundWorkerRunning = false;

function getWebhookTimeoutMs() {
  return Number.parseInt(process.env.OUTBOUND_CALL_WEBHOOK_TIMEOUT_MS, 10) || DEFAULT_WEBHOOK_TIMEOUT_MS;
}

function buildOutboundDispatchPayload(job) {
  return {
    sipCallFrom: process.env.GST_SIP_CALL_FROM || DEFAULT_GST_SIP_CALL_FROM,
    sipCallTo: job.phone,
    routingRuleId: process.env.GST_ROUTING_RULE_ID || DEFAULT_GST_ROUTING_RULE_ID,
    metadata: {
      refrensLeadId: job.refrensLeadId,
      outboundJobId: job._id.toString(),
      source: 'metabase',
      sourceKey: job.sourceKey,
      metabaseQuestionId: job.questionId,
      name: job.name || '',
      business_name: job.businessName || '',
      email: job.email || '',
      previous_stage: job.stage || '',
      webhook_url: process.env.VIDEOSDK_WEBHOOK_URL,
    },
  };
}

async function handleTimedOutOutboundJobs() {
  const timedOutJobs = await findWebhookTimedOutJobs(10);

  for (const job of timedOutJobs) {
    const maxDispatchAttempts = job.maxDispatchAttempts || 2;

    if ((job.dispatchAttempts || 0) < maxDispatchAttempts) {
      const callWindow = applyCallWindow(new Date());
      await requeueOutboundJobAfterWebhookTimeout(job, callWindow.scheduledAt, callWindow.scheduledAtIst);

      logger.warn('Outbound call job webhook timeout; requeued', {
        jobId: job._id.toString(),
        refrensLeadId: job.refrensLeadId,
        dispatchAttempts: job.dispatchAttempts,
        maxDispatchAttempts,
        scheduledAt: callWindow.scheduledAt.toISOString(),
        scheduledAtIst: callWindow.scheduledAtIst,
      });
      continue;
    }

    await markOutboundJobWebhookTimeout(job);

    logger.warn('Outbound call job webhook timeout; max dispatch attempts reached', {
      jobId: job._id.toString(),
      refrensLeadId: job.refrensLeadId,
      dispatchAttempts: job.dispatchAttempts,
      maxDispatchAttempts,
    });
  }
}

async function processOutboundCallJobs() {
  if (outboundWorkerRunning) {
    return;
  }

  if (!process.env.VIDEOSDK_AUTH_TOKEN) {
    logger.warn('Outbound call worker skipped because VIDEOSDK_AUTH_TOKEN is not configured');
    return;
  }

  outboundWorkerRunning = true;

  try {
    await handleTimedOutOutboundJobs();

    if (!isWithinCallWindow()) {
      const nextWindow = applyCallWindow(new Date());
      logger.info('Outbound call worker skipped because current time is outside call window', {
        nextAllowedAt: nextWindow.scheduledAt.toISOString(),
        nextAllowedAtIst: nextWindow.scheduledAtIst,
      });
      return;
    }

    const job = await claimNextOutboundCallJob();

    if (!job) {
      return;
    }

    try {
      const payload = buildOutboundDispatchPayload(job);
      const result = await dispatchSipCall(payload);
      const webhookDeadlineAt = new Date(Date.now() + getWebhookTimeoutMs());

      await markOutboundJobDispatched(job._id.toString(), {
        payload,
        result,
        webhookDeadlineAt,
      });

      logger.info('Outbound GST call dispatched from Metabase job', {
        jobId: job._id.toString(),
        refrensLeadId: job.refrensLeadId,
        sipCallTo: job.phone,
        webhookDeadlineAt: webhookDeadlineAt.toISOString(),
      });
    } catch (error) {
      await markOutboundJobDispatchFailed(job._id.toString(), error);
    }
  } catch (error) {
    logger.error('Outbound call worker failed while processing jobs', {
      message: error.message,
      stack: error.stack,
    });
  } finally {
    outboundWorkerRunning = false;
  }
}

function startOutboundCallWorker() {
  if (process.env.OUTBOUND_CALL_WORKER_ENABLED === 'false') {
    logger.info('Outbound call worker disabled by OUTBOUND_CALL_WORKER_ENABLED=false');
    return null;
  }

  if (outboundWorkerTimer) {
    return outboundWorkerTimer;
  }

  const intervalMs = Number.parseInt(
    process.env.OUTBOUND_CALL_WORKER_INTERVAL_MS,
    10,
  ) || DEFAULT_OUTBOUND_WORKER_INTERVAL_MS;

  outboundWorkerTimer = setInterval(processOutboundCallJobs, intervalMs);
  outboundWorkerTimer.unref?.();

  setTimeout(processOutboundCallJobs, 8000).unref?.();

  logger.info('Outbound call worker started', {
    intervalMs,
  });

  return outboundWorkerTimer;
}

module.exports = {
  buildOutboundDispatchPayload,
  processOutboundCallJobs,
  startOutboundCallWorker,
};
