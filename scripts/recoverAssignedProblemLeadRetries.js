const fs = require('node:fs');
const path = require('node:path');
const { MongoClient, ObjectId } = require('mongodb');
const { applyCallWindow } = require('../src/utils/businessHours');
const { getProblemLeadsRetryDecision } = require('../src/handlers/gstRetry');
const { buildRetryDedupeKey } = require('../src/repositories/retryJobs');

const SOURCE = 'problem_leads_outreach';
const CAMPAIGN = 'Reach_Out_Problem_Leads';
const SKIP_REASON = 'live Refrens lead assigned before retry dispatch';

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
}

function migrationFor({ retry, outbound, event, scheduledAt }) {
  const metadata = retry.dispatchPayload.metadata;
  const parsed = {
    ...event.parsed,
    agentType: 'adhoc',
    sourceKey: SOURCE,
    campaign: CAMPAIGN,
    callStatus: event.parsed.gstCallStatus || event.parsed.callStatus,
    outboundJobId: outbound._id.toString(),
  };
  const decision = getProblemLeadsRetryDecision(parsed);
  if (!decision.shouldRetry || decision.nextAttempt !== retry.retryAttempt) {
    throw new Error(`Lead ${retry.refrensLeadId} no longer qualifies for this retry`);
  }
  return {
    sourceKey: SOURCE,
    campaign: CAMPAIGN,
    agentType: 'adhoc',
    dedupeKey: buildRetryDedupeKey({ agentType: 'adhoc', leadId: retry.refrensLeadId, nextAttempt: retry.retryAttempt }),
    dispatchPayload: {
      ...retry.dispatchPayload,
      metadata: {
        ...metadata,
        sourceKey: SOURCE,
        campaign: CAMPAIGN,
        agentType: 'adhoc',
        outboundJobId: outbound._id.toString(),
        metabaseRunId: outbound.runId.toString(),
        routingRuleId: retry.dispatchPayload.routingRuleId,
      },
    },
    ...applyCallWindow(scheduledAt),
  };
}

async function main() {
  const runId = option('--run-id');
  const expectedCount = Number(option('--expected-count'));
  const apply = process.argv.includes('--apply');
  if (!ObjectId.isValid(runId) || !Number.isInteger(expectedCount) || expectedCount < 1) {
    throw new Error('Provide --run-id <ObjectId> --expected-count <number>; default is dry run');
  }
  if (apply) {
    const revision = option('--expected-revision');
    if (!revision) throw new Error('Apply requires --expected-revision <deployed commit>');
    const health = await fetch('https://videosdk-webhook-backend.onrender.com/health', { signal: AbortSignal.timeout(20000) });
    if (!health.ok || (await health.json()).revision !== revision) {
      throw new Error('Expected revision is not live; no jobs changed');
    }
  }
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI must be supplied through the environment');
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB_NAME || 'videosdk_crm');
    const outboundCollection = db.collection('outbound_call_jobs');
    const retryCollection = db.collection('call_retry_jobs');
    const eventsCollection = db.collection('call_events');
    const jobs = await outboundCollection.find({ runId: new ObjectId(runId) }).toArray();
    if (!jobs.length) throw new Error('Run has no outbound jobs');
    const events = await eventsCollection.find({ callId: { $in: jobs.map((job) => job.callId).filter(Boolean) }, webhookType: 'call-summary' }).toArray();
    const candidates = await retryCollection.find({
      sourceEventId: { $in: events.map((event) => event._id) },
      status: 'skipped_before_dispatch',
      closeReason: SKIP_REASON,
      retryAttempt: 2,
      dispatchResult: null,
    }).sort({ createdAt: 1 }).toArray();
    const recovered = await retryCollection.countDocuments({ 'recovery.runId': runId });
    if (candidates.length + recovered !== expectedCount) {
      throw new Error(`Expected ${expectedCount} jobs, found ${candidates.length} eligible and ${recovered} previously recovered`);
    }
    const startAt = new Date(Date.now() + 60000);
    const plans = candidates.map((retry, index) => {
      const event = events.find((item) => String(item._id) === String(retry.sourceEventId));
      const outbound = jobs.find((job) => job.callId === event.callId && job.refrensLeadId === retry.refrensLeadId);
      if (!outbound || outbound.sourceKey !== 'gst_unassigned_leads') throw new Error('Unexpected original cohort');
      return { retry, outbound, event, migration: migrationFor({ retry, outbound, event, scheduledAt: new Date(startAt.getTime() + index * 2000) }) };
    });
    for (const plan of plans) {
      const conflict = await retryCollection.findOne({
        _id: { $ne: plan.retry._id },
        $or: [{ dedupeKey: plan.migration.dedupeKey }, { refrensLeadId: plan.retry.refrensLeadId, status: { $in: ['scheduled', 'dispatching', 'dispatched'] } }],
      });
      if (conflict) throw new Error(`Conflicting retry exists for ${plan.retry.refrensLeadId}; no recovery applied`);
      const newerEvent = await eventsCollection.findOne({
        refrensLeadId: plan.retry.refrensLeadId,
        webhookType: 'call-summary',
        receivedAt: { $gt: plan.event.receivedAt },
      });
      if (newerEvent) throw new Error(`A newer call exists for ${plan.retry.refrensLeadId}; review before recovery`);
    }
    const audit = {
      checkedAt: new Date(), runId, apply, alreadyRecovered: recovered,
      plans: plans.map(({ retry, outbound, migration }) => ({ retryId: retry._id, outboundJobId: outbound._id, leadId: retry.refrensLeadId, retryAttempt: retry.retryAttempt, scheduledAt: migration.scheduledAt, fromSource: outbound.sourceKey, toSource: SOURCE, sipCallFrom: retry.dispatchPayload.sipCallFrom, routingRuleId: retry.dispatchPayload.routingRuleId })),
      before: apply ? plans.map(({ retry, outbound }) => ({ retry, outbound })) : undefined,
    };
    if (apply && plans.length) {
      const auditPath = path.resolve(option('--audit-file') || `recovery-${runId}.json`);
      fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2), { flag: 'wx' });
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          for (const { retry, outbound, migration } of plans) {
            const now = new Date();
            const retryResult = await retryCollection.updateOne({ _id: retry._id, status: 'skipped_before_dispatch', closeReason: SKIP_REASON, dispatchResult: null }, {
              $set: {
                dedupeKey: migration.dedupeKey, sourceKey: SOURCE, agentType: 'adhoc',
                status: 'scheduled', terminalStatus: null, closeReason: null,
                skippedAt: null, completedAt: null, lockedAt: null, failedAt: null, lastError: null,
                assignees: [], matchedSkipTags: [], scheduledAt: migration.scheduledAt,
                scheduledAtIst: migration.scheduledAtIst, businessHoursAdjusted: migration.adjusted,
                dispatchPayload: migration.dispatchPayload, updatedAt: now,
                recovery: { runId, recoveredAt: now, originalSourceKey: outbound.sourceKey, originalDedupeKey: retry.dedupeKey, originalStatus: retry.status, originalReason: retry.closeReason, originalScheduledAt: retry.scheduledAt },
              },
            }, { session });
            if (retryResult.modifiedCount !== 1) throw new Error('Retry changed during recovery; transaction rolled back');
            const jobResult = await outboundCollection.updateOne({ _id: outbound._id, sourceKey: 'gst_unassigned_leads', status: 'summary_received' }, {
              $set: {
                dedupeKey: `${SOURCE}:${runId}:${outbound.refrensLeadId}`,
                sourceKey: SOURCE, agentType: 'adhoc', campaign: CAMPAIGN, updatedAt: now,
                recovery: { runId, recoveredAt: now, originalSourceKey: outbound.sourceKey, originalDedupeKey: outbound.dedupeKey },
              },
            }, { session });
            if (jobResult.modifiedCount !== 1) throw new Error('Outbound job changed during recovery; transaction rolled back');
          }
        });
      } finally { await session.endSession(); }
    }
    console.log(JSON.stringify({ ...audit, before: undefined, recoveredCount: apply ? plans.length : 0 }, null, 2));
  } finally { await client.close(); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { migrationFor };
