const { fetchQuestionRows } = require('../services/metabase');
const {
  createMetabaseRun,
  markMetabaseRunCompleted,
  markMetabaseRunFailed,
} = require('../repositories/metabaseRuns');
const {
  createOutboundCallJob,
  createSkippedOutboundCallJob,
  findActiveJobForLead,
  findClosedCohortJobForLead,
} = require('../repositories/outboundCallJobs');
const { findActiveRetryJobForLead } = require('../repositories/retryJobs');
const { applyCallWindow } = require('../utils/businessHours');
const logger = require('../utils/logger');

const GST_UNASSIGNED_SOURCE_KEY = 'gst_unassigned_leads';
const DEFAULT_GST_UNASSIGNED_QUESTION_ID = '4645';
const DEFAULT_MAX_RUN_LEAD_RESULTS = 1000;

const GST_TAG_IDS = {
  voiceAiAttempt: 'a4Anq_x2Vmere1G-AqRXB',
  salesPersonCallback: 'ONQWVW1-utEzlg7E4tT3F',
  gstConfirmed: 'lhZNBczeoRecfbNQvTcHa',
  identityConfirmed: 'sM1iZbCixqm7Ldibszs2f',
};

const GST_FIRST_CALL_BLOCKING_TAGS = new Set([
  GST_TAG_IDS.salesPersonCallback,
  GST_TAG_IDS.gstConfirmed,
  GST_TAG_IDS.identityConfirmed,
  'Sales Person Callback',
  'Sales Person callback',
  'GST Confirmed',
  'Identity Confirmed',
]);

const PHONE_FIELD_CANDIDATES = [
  'phone',
  'Phone',
  'contactPhone',
  'contact_phone',
  'clientPhone',
  'client_phone',
  'mobile',
  'Mobile',
  'phoneNumber',
  'phone_number',
  'contact.phone',
  'ref.contact.phone',
  'ref.contact.mobile',
];

function getQuestionId() {
  return process.env.METABASE_GST_UNASSIGNED_QUESTION_ID || DEFAULT_GST_UNASSIGNED_QUESTION_ID;
}

function normalizePhone(phone) {
  if (typeof phone === 'string') {
    return phone.trim();
  }

  if (typeof phone === 'number' || typeof phone === 'bigint') {
    return String(phone).trim();
  }

  if (Array.isArray(phone)) {
    for (const value of phone) {
      const normalized = normalizePhone(value);
      if (normalized) {
        return normalized;
      }
    }
  }

  if (phone && typeof phone === 'object') {
    return normalizePhone(
      phone.phone ||
      phone.mobile ||
      phone.value ||
      phone.number ||
      phone.raw ||
      phone.text ||
      '',
    );
  }

  return '';
}

function getPathValue(row, path) {
  if (!row || !path) {
    return undefined;
  }

  if (Object.prototype.hasOwnProperty.call(row, path)) {
    return row[path];
  }

  return path.split('.').reduce((current, key) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }

    return current[key];
  }, row);
}

function normalizeFieldName(fieldName) {
  return String(fieldName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractPhone(row) {
  for (const field of PHONE_FIELD_CANDIDATES) {
    const phone = normalizePhone(getPathValue(row, field));

    if (phone) {
      return {
        phone,
        phoneSource: field,
      };
    }
  }

  const fallback = Object.entries(row || {}).find(([key, value]) => {
    const normalizedKey = normalizeFieldName(key);
    return (
      (normalizedKey.includes('phone') || normalizedKey.includes('mobile')) &&
      Boolean(normalizePhone(value))
    );
  });

  if (fallback) {
    return {
      phone: normalizePhone(fallback[1]),
      phoneSource: fallback[0],
    };
  }

  return {
    phone: '',
    phoneSource: null,
  };
}

function normalizeLeadId(value) {
  if (!value) {
    return null;
  }

  return String(value).trim();
}

function getTagId(tag) {
  if (!tag) {
    return null;
  }

  if (typeof tag === 'string') {
    return tag.trim();
  }

  return (
    tag.id ||
    tag._id ||
    tag.key ||
    tag.value ||
    tag.tagId ||
    tag.name ||
    tag.label ||
    null
  );
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }

  return tags.map((tag) => ({
    raw: tag,
    id: getTagId(tag),
    name: typeof tag === 'object' && tag ? tag.name || tag.label || null : null,
  }));
}

function normalizeLeadRow(row) {
  const phone = extractPhone(row);

  return {
    leadId: normalizeLeadId(row._id || row.id || row.leadId),
    createdAt: row.createdAt || null,
    name: row.clientName || row.name || '',
    businessName: row.companyName || row.businessName || '',
    phone: phone.phone,
    phoneSource: phone.phoneSource,
    email: row.email || '',
    subject: row.subject || '',
    status: row.status || '',
    stage: row.stage || '',
    tags: normalizeTags(row.tags),
  };
}

function getMaxRunLeadResults() {
  const configured = Number.parseInt(process.env.METABASE_RUN_LEAD_RESULTS_LIMIT, 10);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_RUN_LEAD_RESULTS;
}

function buildRunLeadResult({
  lead,
  status,
  reason,
  matchedSkipTags,
  jobId,
  activeJobId,
  activeJobStatus,
  activeRetryJobId,
  activeRetryJobStatus,
  activeRetryAttempt,
  activeRetryScheduledAtIst,
  closedCohortJobId,
  closedCohortStatus,
  cohortCloseReason,
  cohortClosedAt,
  scheduledWindow,
}) {
  return {
    leadId: lead.leadId || null,
    phone: lead.phone || '',
    phoneSource: lead.phoneSource || null,
    name: lead.name || '',
    businessName: lead.businessName || '',
    stage: lead.stage || '',
    status,
    reason: reason || null,
    matchedSkipTags: matchedSkipTags || [],
    jobId: jobId || null,
    activeJobId: activeJobId || null,
    activeJobStatus: activeJobStatus || null,
    activeRetryJobId: activeRetryJobId || null,
    activeRetryJobStatus: activeRetryJobStatus || null,
    activeRetryAttempt: activeRetryAttempt || null,
    activeRetryScheduledAtIst: activeRetryScheduledAtIst || null,
    closedCohortJobId: closedCohortJobId || null,
    closedCohortStatus: closedCohortStatus || null,
    cohortCloseReason: cohortCloseReason || null,
    cohortClosedAt: cohortClosedAt || null,
    scheduledAt: scheduledWindow?.scheduledAt || null,
    scheduledAtIst: scheduledWindow?.scheduledAtIst || null,
  };
}

function getBlockingTags(lead) {
  return lead.tags
    .filter((tag) => tag.id && GST_FIRST_CALL_BLOCKING_TAGS.has(tag.id))
    .map((tag) => tag.id);
}

async function classifyLeadForGstCall({ sourceKey, lead }) {
  if (!lead.leadId) {
    return {
      eligible: false,
      reason: 'missing Refrens lead id',
      matchedSkipTags: [],
    };
  }

  const activeJob = await findActiveJobForLead({
    sourceKey,
    refrensLeadId: lead.leadId,
  });

  if (activeJob) {
    return {
      eligible: false,
      reason: 'active outbound call job already exists for lead',
      matchedSkipTags: [],
      activeJobId: activeJob._id?.toString(),
      activeJobStatus: activeJob.status || null,
      shouldCreateSkippedJob: false,
    };
  }

  const activeRetryJob = await findActiveRetryJobForLead(lead.leadId);

  if (activeRetryJob) {
    return {
      eligible: false,
      reason: 'active retry job already exists for lead',
      matchedSkipTags: [],
      activeRetryJobId: activeRetryJob._id?.toString(),
      activeRetryJobStatus: activeRetryJob.status || null,
      activeRetryAttempt: activeRetryJob.retryAttempt || null,
      activeRetryScheduledAtIst: activeRetryJob.scheduledAtIst || null,
      shouldCreateSkippedJob: false,
    };
  }

  const closedCohortJob = await findClosedCohortJobForLead({
    sourceKey,
    refrensLeadId: lead.leadId,
  });

  if (closedCohortJob) {
    return {
      eligible: false,
      reason: 'lead already completed or exhausted this cohort',
      matchedSkipTags: [],
      closedCohortJobId: closedCohortJob._id?.toString(),
      closedCohortStatus: closedCohortJob.status || null,
      cohortCloseReason: closedCohortJob.cohortCloseReason || closedCohortJob.closeReason || null,
      cohortClosedAt: closedCohortJob.cohortClosedAt || closedCohortJob.closedAt || null,
      shouldCreateSkippedJob: false,
    };
  }

  if (!lead.phone) {
    return {
      eligible: false,
      reason: 'missing phone',
      matchedSkipTags: [],
    };
  }

  const matchedSkipTags = getBlockingTags(lead);

  if (matchedSkipTags.length > 0) {
    return {
      eligible: false,
      reason: 'lead already has GST blocking tag',
      matchedSkipTags,
    };
  }

  return {
    eligible: true,
    reason: null,
    matchedSkipTags: [],
  };
}

async function runGstUnassignedMetabaseImport({ requestedBy, limit, parameters } = {}) {
  const questionId = getQuestionId();
  const run = await createMetabaseRun({
    sourceKey: GST_UNASSIGNED_SOURCE_KEY,
    questionId,
    requestedBy,
    parameters,
  });
  const runId = run?._id?.toString();

  try {
    const result = await fetchQuestionRows(questionId, parameters || {});
    const rows = Number.isInteger(limit) && limit > 0 ? result.rows.slice(0, limit) : result.rows;
    const stats = {
      fetchedCount: rows.length,
      eligibleCount: 0,
      skippedCount: 0,
      queuedCount: 0,
      leadResultsCount: 0,
      leadResultsTruncated: false,
      leadIds: [],
      queuedLeadIds: [],
      skippedLeadIds: [],
      leadResults: [],
    };
    const jobs = [];
    const maxRunLeadResults = getMaxRunLeadResults();

    function addRunLeadResult(result) {
      stats.leadResultsCount += 1;

      if (result.leadId) {
        stats.leadIds.push(result.leadId);
        if (result.status === 'scheduled') {
          stats.queuedLeadIds.push(result.leadId);
        }
        if (result.status === 'skipped') {
          stats.skippedLeadIds.push(result.leadId);
        }
      }

      if (stats.leadResults.length < maxRunLeadResults) {
        stats.leadResults.push(result);
      } else {
        stats.leadResultsTruncated = true;
      }
    }

    for (const row of rows) {
      const lead = normalizeLeadRow(row);
      const classification = await classifyLeadForGstCall({
        sourceKey: GST_UNASSIGNED_SOURCE_KEY,
        lead,
      });

      if (!classification.eligible) {
        stats.skippedCount += 1;
        const skippedJob = classification.shouldCreateSkippedJob === false
          ? null
          : await createSkippedOutboundCallJob({
            runId,
            sourceKey: GST_UNASSIGNED_SOURCE_KEY,
            questionId,
            lead,
            rawRow: row,
            skipReason: classification.reason,
            matchedSkipTags: classification.matchedSkipTags,
          });

        jobs.push({
          leadId: lead.leadId,
          status: 'skipped',
          reason: classification.reason,
          matchedSkipTags: classification.matchedSkipTags,
          jobId: skippedJob?._id?.toString() || null,
          activeJobId: classification.activeJobId || null,
          activeJobStatus: classification.activeJobStatus || null,
          activeRetryJobId: classification.activeRetryJobId || null,
          activeRetryJobStatus: classification.activeRetryJobStatus || null,
          activeRetryAttempt: classification.activeRetryAttempt || null,
          activeRetryScheduledAtIst: classification.activeRetryScheduledAtIst || null,
          closedCohortJobId: classification.closedCohortJobId || null,
          closedCohortStatus: classification.closedCohortStatus || null,
          cohortCloseReason: classification.cohortCloseReason || null,
          cohortClosedAt: classification.cohortClosedAt || null,
        });
        addRunLeadResult(buildRunLeadResult({
          lead,
          status: 'skipped',
          reason: classification.reason,
          matchedSkipTags: classification.matchedSkipTags,
          jobId: skippedJob?._id?.toString() || null,
          activeJobId: classification.activeJobId || null,
          activeJobStatus: classification.activeJobStatus || null,
          activeRetryJobId: classification.activeRetryJobId || null,
          activeRetryJobStatus: classification.activeRetryJobStatus || null,
          activeRetryAttempt: classification.activeRetryAttempt || null,
          activeRetryScheduledAtIst: classification.activeRetryScheduledAtIst || null,
          closedCohortJobId: classification.closedCohortJobId || null,
          closedCohortStatus: classification.closedCohortStatus || null,
          cohortCloseReason: classification.cohortCloseReason || null,
          cohortClosedAt: classification.cohortClosedAt || null,
        }));
        continue;
      }

      const scheduledWindow = applyCallWindow(new Date());
      const job = await createOutboundCallJob({
        runId,
        sourceKey: GST_UNASSIGNED_SOURCE_KEY,
        questionId,
        lead,
        rawRow: row,
        scheduledAt: scheduledWindow.scheduledAt,
        scheduledAtIst: scheduledWindow.scheduledAtIst,
        businessHoursAdjusted: scheduledWindow.adjusted,
      });

      stats.eligibleCount += 1;
      stats.queuedCount += 1;
      jobs.push({
        leadId: lead.leadId,
        status: 'scheduled',
        jobId: job?._id?.toString() || null,
        scheduledAt: scheduledWindow.scheduledAt,
        scheduledAtIst: scheduledWindow.scheduledAtIst,
      });
      addRunLeadResult(buildRunLeadResult({
        lead,
        status: 'scheduled',
        jobId: job?._id?.toString() || null,
        scheduledWindow,
      }));
    }

    await markMetabaseRunCompleted(runId, stats);

    logger.info('GST Metabase unassigned run completed', {
      runId,
      questionId,
      ...stats,
    });

    return {
      success: true,
      runId,
      sourceKey: GST_UNASSIGNED_SOURCE_KEY,
      questionId,
      ...stats,
      jobs,
    };
  } catch (error) {
    await markMetabaseRunFailed(runId, error);

    logger.error('GST Metabase unassigned run failed', {
      runId,
      questionId,
      message: error.message,
      status: error.response?.status,
      response: error.response?.data,
    });

    throw error;
  }
}

module.exports = {
  GST_FIRST_CALL_BLOCKING_TAGS,
  GST_TAG_IDS,
  GST_UNASSIGNED_SOURCE_KEY,
  classifyLeadForGstCall,
  getQuestionId,
  normalizeLeadRow,
  runGstUnassignedMetabaseImport,
};
