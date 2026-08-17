const {
  claimDueRetryJobs,
  findRetryJobsMissingSummary,
  markRetryJobDispatched,
  markRetryJobFailed,
  markRetryJobRescheduled,
  markRetryJobSkippedBeforeDispatch,
  markRetryJobSummaryTimeout,
} = require('../repositories/retryJobs');
const {
  extractLeadAssignees,
  extractLeadTagIds,
  getLeadInCrm,
  isLeadNotFoundError,
} = require('../handlers/crm');
const { dispatchSipCall, getVideoSdkAuthToken } = require('../services/videosdk');
const { applyCallWindow, isWithinCallWindow } = require('../utils/businessHours');
const logger = require('../utils/logger');

const DEFAULT_RETRY_WORKER_INTERVAL_MS = 60 * 1000;
const DEFAULT_RETRY_SUMMARY_TIMEOUT_MS = 6 * 60 * 1000;
const GST_RETRY_BLOCKING_TAGS = new Set([
  'ONQWVW1-utEzlg7E4tT3F',
  'lhZNBczeoRecfbNQvTcHa',
  'sM1iZbCixqm7Ldibszs2f',
  'Sales Person Callback',
  'Sales Person callback',
  'GST Confirmed',
  'Identity Confirmed',
  'Identity confirmed',
]);

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

async function getLiveRetryBlockers(job) {
  const crmLead = await getLeadInCrm(job.refrensLeadId);
  const tagIds = extractLeadTagIds(crmLead);
  const matchedSkipTags = tagIds.filter((tagId) => GST_RETRY_BLOCKING_TAGS.has(tagId));
  const assignees = extractLeadAssignees(crmLead);

  return {
    crmLead,
    tagIds,
    matchedSkipTags,
    assignees,
  };
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

        let liveBlockers;

        try {
          liveBlockers = await getLiveRetryBlockers(job);
        } catch (error) {
          if (isLeadNotFoundError(error)) {
            await markRetryJobSkippedBeforeDispatch(job._id.toString(), {
              reason: 'Refrens lead not found before retry dispatch',
              matchedSkipTags: [],
              assignees: [],
              crmLead: {
                leadId: job.refrensLeadId,
                status: error.response?.status || null,
                response: error.response?.data || null,
              },
            });
            continue;
          }

          throw error;
        }

        if (liveBlockers.assignees.length > 0) {
          await markRetryJobSkippedBeforeDispatch(job._id.toString(), {
            reason: 'live Refrens lead assigned before retry dispatch',
            matchedSkipTags: [],
            assignees: liveBlockers.assignees,
            crmLead: {
              leadId: job.refrensLeadId,
              assignees: liveBlockers.assignees,
              tagIds: liveBlockers.tagIds,
            },
          });

          logger.info('Retry call skipped because lead is assigned', {
            retryJobId: job._id.toString(),
            refrensLeadId: job.refrensLeadId,
            assignees: liveBlockers.assignees,
          });
          continue;
        }

        if (liveBlockers.matchedSkipTags.length > 0) {
          await markRetryJobSkippedBeforeDispatch(job._id.toString(), {
            reason: 'live Refrens lead has GST blocking tag before retry dispatch',
            matchedSkipTags: liveBlockers.matchedSkipTags,
            assignees: [],
            crmLead: {
              leadId: job.refrensLeadId,
              tagIds: liveBlockers.tagIds,
            },
          });

          logger.info('Retry call skipped by live Refrens tag guard', {
            retryJobId: job._id.toString(),
            refrensLeadId: job.refrensLeadId,
            matchedSkipTags: liveBlockers.matchedSkipTags,
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
