const {
  claimDueRetryJobs,
  findRetryJobsMissingSummary,
  markRetryJobDispatched,
  markRetryJobFailed,
  markRetryJobRescheduled,
  markRetryJobSummaryTimeout,
} = require('../repositories/retryJobs');
const { dispatchSipCall, getVideoSdkAuthToken } = require('../services/videosdk');
const { applyCallWindow, isWithinCallWindow } = require('../utils/businessHours');
const logger = require('../utils/logger');

const DEFAULT_RETRY_WORKER_INTERVAL_MS = 60 * 1000;
const DEFAULT_RETRY_SUMMARY_TIMEOUT_MS = 6 * 60 * 1000;

let retryWorkerTimer = null;
let retryWorkerRunning = false;

function getRetrySummaryTimeoutMs() {
  return Number.parseInt(
    process.env.RETRY_CALL_SUMMARY_TIMEOUT_MS || process.env.OUTBOUND_CALL_WEBHOOK_TIMEOUT_MS,
    10,
  ) || DEFAULT_RETRY_SUMMARY_TIMEOUT_MS;
}

async function handleRetryJobsMissingSummary() {
  const jobs = await findRetryJobsMissingSummary(10, getRetrySummaryTimeoutMs());

  for (const job of jobs) {
    await markRetryJobSummaryTimeout(job._id.toString());

    logger.warn('Retry job summary timeout', {
      retryJobId: job._id.toString(),
      refrensLeadId: job.refrensLeadId,
      retryAttempt: job.retryAttempt,
      dispatchedAt: job.dispatchedAt?.toISOString?.(),
    });
  }
}

async function processDueRetryJobs() {
  if (retryWorkerRunning) {
    return;
  }

  if (!getVideoSdkAuthToken()) {
    logger.warn('Retry worker skipped because VIDEOSDK_AUTH_TOKEN is not configured');
    return;
  }

  retryWorkerRunning = true;

  try {
    await handleRetryJobsMissingSummary();

    if (!isWithinCallWindow()) {
      const nextWindow = applyCallWindow(new Date());
      logger.info('Retry worker skipped because current time is outside call window', {
        nextAllowedAt: nextWindow.scheduledAt.toISOString(),
        nextAllowedAtIst: nextWindow.scheduledAtIst,
      });
      return;
    }

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
