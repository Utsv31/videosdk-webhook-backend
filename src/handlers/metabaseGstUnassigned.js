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
} = require('../repositories/outboundCallJobs');
const { applyCallWindow } = require('../utils/businessHours');
const logger = require('../utils/logger');

const GST_UNASSIGNED_SOURCE_KEY = 'gst_unassigned_leads';
const DEFAULT_GST_UNASSIGNED_QUESTION_ID = '4645';

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

function getQuestionId() {
  return process.env.METABASE_GST_UNASSIGNED_QUESTION_ID || DEFAULT_GST_UNASSIGNED_QUESTION_ID;
}

function normalizePhone(phone) {
  return typeof phone === 'string' ? phone.trim() : '';
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
  return {
    leadId: normalizeLeadId(row._id || row.id || row.leadId),
    createdAt: row.createdAt || null,
    name: row.clientName || row.name || '',
    businessName: row.companyName || row.businessName || '',
    phone: normalizePhone(row.phone),
    email: row.email || '',
    subject: row.subject || '',
    status: row.status || '',
    stage: row.stage || '',
    tags: normalizeTags(row.tags),
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
    };
    const jobs = [];

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
        });
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
