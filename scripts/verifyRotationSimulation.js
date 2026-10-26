const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('Provide MONGODB_URI for an isolated test database');
  const mockUrl = process.env.ROTATION_SIMULATION_URL || 'http://127.0.0.1:4916/videosdk';
  if (new URL(mockUrl).hostname !== '127.0.0.1') throw new Error('This verification only calls a loopback mock');
  const dbName = `rotation_test_${Date.now()}_${randomUUID().slice(0, 6)}`;
  process.env.MONGODB_DB_NAME = dbName;
  process.env.VIDEOSDK_API_BASE_URL = mockUrl;
  process.env.VIDEOSDK_AUTH_TOKEN = 'simulation-only';
  process.env.VIDEOSDK_WEBHOOK_URL = 'https://example.com/webhook';
  process.env.JOBS_API_TOKEN = 'rotation-simulation-only';
  delete process.env.VIDEOSDK_WEBHOOK_SECRET;
  delete process.env.VIDEOSDK_WEBHOOK_SECRET_FILE;
  const config = {
    ...require('../config/rotationalCalls.json'), enabled: true, consentConfirmed: true,
    recipients: [1, 2, 3, 4].map(n => ({ phone: `+91900000000${n}`, name: `Test ${n}` })),
    callerRoutes: [5, 6].map(n => ({ sipCallFrom: `+91900000000${n}`, routingRuleId: `rr_test${n}` })),
  };
  process.env.ROTATIONAL_CALLS_CONFIG = JSON.stringify(config);
  const { buildRotationPlan, istDate } = require('../src/utils/rotationPlan');
  const repo = require('../src/repositories/rotationJobs');
  const { processRotationCallJobs } = require('../src/workers/rotationWorker');
  const { getDb, closeMongo } = require('../src/services/mongo');
  const { isWithinCallWindow } = require('../src/utils/businessHours');
  if (!isWithinCallWindow()) throw new Error('Run this simulation between 09:00 and 21:00 IST');
  const db = await getDb();
  const jobs = db.collection('rotational_call_jobs');
  const date = istDate();
  const desired = buildRotationPlan(config, date);
  const app = require('../src/app');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-jobs-api-token': 'rotation-simulation-only', 'Content-Type': 'application/json' };
  try {
    const preview = await fetch(`${base}/jobs/rotation/run`, { method: 'POST', headers, body: '{}' });
    assert.equal((await preview.json()).dryRun, true);
    assert.equal(await jobs.countDocuments({}), 0);
    const queued = await fetch(`${base}/jobs/rotation/run`, { method: 'POST', headers, body: '{"dryRun":false}' });
    assert.equal(queued.status, 200);
    await Promise.all([repo.ensureRotationPlan(desired), repo.ensureRotationPlan(desired)]);
    assert.equal(await jobs.countDocuments({}), 20, 'duplicate run must reuse daily slots');
    // Seed one due slot; keep the rest in the future so fixture timing is deterministic.
    await jobs.updateMany({}, { $set: { scheduledAt: new Date(Date.now() + 3600000), expiresAt: new Date(Date.now() + 7200000) } });
    const first = await jobs.findOne({ slot: 0 });
    await jobs.updateOne({ _id: first._id }, { $set: { scheduledAt: new Date(Date.now() - 1000) } });
    await Promise.all([processRotationCallJobs(), processRotationCallJobs()]);
    const dispatched = await jobs.findOne({ _id: first._id });
    assert.equal(dispatched.status, 'dispatched');
    assert.equal(dispatched.dispatchAttempts, 1);
    assert.ok(dispatched.callId);
    assert.equal(dispatched.dispatchPayload.metadata.sourceKey, 'rotational_calls');
    assert.equal(dispatched.dispatchPayload.metadata.refrensLeadId, null);
    assert.equal(await repo.acquireRotationLock(new Date(), 5), null, 'minimum gap persists after worker release');
    const summary = {
      'call-summary': { call_status: 'call_not_picked', summary: 'Simulation only.' },
      'customer-data': { ...dispatched.dispatchPayload.metadata, callId: dispatched.callId },
      'room-data': { agentId: 'ag_n8irvh', 'meeting-id': 'simulation-room' },
    };
    await fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summary) });
    for (let i = 0; i < 100; i++) {
      const row = await jobs.findOne({ _id: first._id });
      if (row.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal((await jobs.findOne({ _id: first._id })).status, 'completed');
    await repo.markRotationResult(first._id, { result: dispatched.dispatchResult });
    assert.equal((await jobs.findOne({ _id: first._id })).status, 'completed', 'late dispatch result must not overwrite summary');
    await repo.recordRotationWebhook({ jobId: first._id.toString(), callId: dispatched.callId, roomId: 'simulation-room', webhookType: 'call-started', body: {} });
    assert.equal((await jobs.findOne({ _id: first._id })).status, 'completed', 'late start must not reopen completed job');
    assert.equal(await db.collection('call_retry_jobs').countDocuments({}), 0);
    assert.equal(await db.collection('outbound_call_jobs').countDocuments({}), 0);
    const event = await db.collection('call_events').findOne({ callId: dispatched.callId });
    assert.equal(event.refrens.attempted, false);
    assert.equal(event.rotationJobId, first._id.toString());
    const noMetadata = { ...summary, 'customer-data': { callId: dispatched.callId } };
    await fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(noMetadata) });

    // A response error, uncertain 5xx, and a 200 without ID must never be resubmitted.
    for (const [failure, expected, slot] of [['400', 'dispatch_failed', 1], ['500', 'dispatch_unknown', 2], ['no-id', 'dispatch_unknown', 3]]) {
      await db.collection('rotational_call_locks').updateOne({ _id: desired.workflow }, { $set: { nextAllowedAt: new Date(0) } });
      await jobs.updateOne({ slot }, { $set: { scheduledAt: new Date(Date.now() - 1000) } });
      process.env.VIDEOSDK_API_BASE_URL = `${mockUrl}/fail-${failure}`;
      await processRotationCallJobs();
      assert.equal((await jobs.findOne({ slot })).status, expected);
      await processRotationCallJobs();
      assert.equal((await jobs.findOne({ slot })).dispatchAttempts, 1);
    }
    const stale = await jobs.findOne({ slot: 4 });
    await jobs.updateOne({ _id: stale._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    const crashed = await jobs.findOne({ slot: 5 });
    await jobs.updateOne({ _id: crashed._id }, { $set: { status: 'dispatching', lockedAt: new Date(Date.now() - 61000) } });
    await repo.sweepRotationJobs(new Date());
    assert.equal((await jobs.findOne({ _id: stale._id })).status, 'expired');
    assert.equal((await jobs.findOne({ _id: crashed._id })).status, 'dispatch_unknown');

    await db.collection('rotational_call_locks').updateOne({ _id: desired.workflow }, { $set: { nextAllowedAt: new Date(0), lockedUntil: new Date(0) } });
    const contenders = await Promise.all(Array.from({ length: 4 }, () => repo.acquireRotationLock(new Date(), 5)));
    assert.equal(contenders.filter(Boolean).length, 1, 'only one independent Mongo lease contender can win');
    await repo.releaseRotationLock(contenders.find(Boolean).token);

    const stop = await fetch(`${base}/jobs/rotation/stop`, { method: 'POST', headers, body: '{}' });
    assert.equal(stop.status, 200);
    await repo.ensureRotationPlan(desired);
    assert.equal(await jobs.countDocuments({ status: 'scheduled' }), 0);
    assert.equal((await repo.getRotationStatus(date)).plan.status, 'stopped');
    console.log(JSON.stringify({ verified: true, database: dbName, checks: ['dry-run', 'daily dedupe', '20 slots', 'atomic claim', 'minimum gap', 'real HTTP dispatch', 'summary webhook', 'no CRM/retries', '400/500/no-ID', 'no automatic resend', 'expired slots', 'crash reconciliation', 'stop persists'] }));
  } finally {
    await new Promise(resolve => server.close(resolve));
    // Only clear collections in this run's uniquely named test database.
    assert.ok(dbName.startsWith('rotation_test_'));
    try {
      for (const name of ['rotational_call_jobs', 'rotational_call_days', 'rotational_call_locks', 'call_events']) {
        await db.collection(name).deleteMany({});
      }
    } finally { await closeMongo(); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
