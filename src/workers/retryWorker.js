const {
  claimDueRetryJobs,
  markRetryJobDispatched,
  markRetryJobFailed,
  markRetryJobRescheduled,
} = require('../repositories/retryJobs');
const { dispatchSipCall } = require('../services/videosdk');
const { applyCallWindow, isWithinCallWindow } = require('../utils/businessHours');
const logger = require('../utils/logger');

const DEFAULT_RETRY_WORKER_INTERVAL_MS = 60 * 1000;

let retryWorkerTimer = null;
let retryWorkerRunning = false;

async function processDueRetryJobs() {
  if (retryWorkerRunning) {
    return;
  }

  if (!process.env.VIDEOSDK_AUTH_TOKEN) {
    logger.warn('Retry worker skipped because VIDEOSDK_AUTH_TOKEN is not configured');
    return;
  }

  if (!isWithinCallWindow()) {
    const nextWindow = applyCallWindow(new Date());
    logger.info('Retry worker skipped because current time is outside call window', {
      nextAllowedAt: nextWindow.scheduledAt.toISOString(),
      nextAllowedAtIst: nextWindow.scheduledAtIst,
    });
    return;
  }

  retryWorkerRunning = true;

  try {
    const jobs = await claimDueRetryJobs(5);

    for (const job of jobs) {
      try {
        if (!isWithinCallWindow()) {
          const nextWindow = applyCallWindow(new Date());
          await markRetryJobRescheduled(job._id.toString(), {
            scheduledAt: nextWindow.scheduledAt,
            scheduledAtIst: nextWindow.scheduledAtIst,
            reason: 'call window closed before dispatch',
          });
          continue;
        }

        const result = await dispatchSipCall(job.dispatchPayload);
        await markRetryJobDispatched(job._id.toString(), result);
      } catch (error) {
        await markRetryJobFailed(job._id.toString(), error);
      }
    }
  } catch (error) {
    logger.error('Retry worker failed while processing due jobs', {
      message: error.message,
      stack: error.stack,
    });
  } finally {
    retryWorkerRunning = false;
  }
}

function startRetryWorker() {
  if (process.env.RETRY_WORKER_ENABLED === 'false') {
    logger.info('Retry worker disabled by RETRY_WORKER_ENABLED=false');
    return null;
  }

  if (retryWorkerTimer) {
    return retryWorkerTimer;
  }

  const intervalMs = Number.parseInt(process.env.RETRY_WORKER_INTERVAL_MS, 10) || DEFAULT_RETRY_WORKER_INTERVAL_MS;

  retryWorkerTimer = setInterval(processDueRetryJobs, intervalMs);
  retryWorkerTimer.unref?.();

  setTimeout(processDueRetryJobs, 5000).unref?.();

  logger.info('Retry worker started', {
    intervalMs,
  });

  return retryWorkerTimer;
}

module.exports = {
  processDueRetryJobs,
  startRetryWorker,
};
