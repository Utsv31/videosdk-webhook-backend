const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRotationPlan, getRotationContext, istDate, validateRotationConfig } = require('../src/utils/rotationPlan');
const { buildRotationDispatchPayload } = require('../src/workers/rotationWorker');
const { processCallSummary } = require('../src/handlers/callSummary');
const defaults = require('../config/rotationalCalls.json');

function config(changes = {}) {
  return {
    ...defaults,
    recipients: [1, 2, 3, 4].map(n => ({ phone: `+91900000000${n}`, name: `Test ${n}` })),
    callerRoutes: [5, 6].map(n => ({ sipCallFrom: `+91900000000${n}`, routingRuleId: `rr_test${n}` })),
    ...changes,
  };
}

test('five calls per recipient produces 20 unique slots spread across the IST day', () => {
  const plan = buildRotationPlan(config(), '2026-10-26');
  assert.equal(plan.total, 20);
  assert.equal(plan.jobs[0].scheduledAt.toISOString(), '2026-10-26T03:30:00.000Z');
  assert.equal(plan.jobs.at(-1).scheduledAt.toISOString(), '2026-10-26T14:54:00.000Z');
  assert.equal(new Set(plan.jobs.map(j => j.dedupeKey)).size, 20);
  for (const recipient of config().recipients) {
    const slots = plan.jobs.filter(j => j.phone === recipient.phone);
    assert.equal(slots.length, 5);
    assert.equal(new Set(slots.map(j => j.sipCallFrom)).size, 2);
  }
  for (let i = 1; i < 20; i++) assert.ok(plan.jobs[i].scheduledAt - plan.jobs[i - 1].scheduledAt >= 5 * 60000);
  assert.deepEqual(plan, buildRotationPlan(config(), '2026-10-26'));
});

test('total mode caps the whole day and new IST dates receive distinct keys', () => {
  const c = config({ dailyLimitMode: 'total', dailyCalls: 10 });
  assert.equal(buildRotationPlan(c, '2026-10-26').jobs.length, 10);
  assert.notEqual(buildRotationPlan(c, '2026-10-26')._id, buildRotationPlan(c, '2026-10-27')._id);
  assert.equal(istDate(new Date('2026-10-26T19:00:00Z')), '2026-10-27');
});

test('invalid limits, routes, dates and insufficient windows fail closed', () => {
  for (const changes of [
    { dailyCalls: 0 }, { dailyCalls: 11 }, { dailyCalls: '5' }, { dailyLimitMode: 'anything' },
    { minimumGapMinutes: 4 }, { startHourIst: 8 }, { endHourIst: 22 },
    { recipients: [] }, { recipients: Array(4).fill({ phone: '+919000000001' }) },
    { callerRoutes: [{ sipCallFrom: '+919000000005', routingRuleId: '' }] },
    { metadata: [] }, { dailyCalls: 10, startHourIst: 9, endHourIst: 10 },
  ]) assert.throws(() => buildRotationPlan(config(changes), '2026-10-26'));
  for (const date of ['2026-02-30', 'anything', '2026-13-01']) assert.throws(() => buildRotationPlan(config(), date));
  assert.throws(() => validateRotationConfig(config(), { live: true }), /consentConfirmed/);
  validateRotationConfig(config({ enabled: true, consentConfirmed: true }), { live: true });
});

test('rotation metadata is isolated from CRM and its direct summary path does not touch retries', async () => {
  const plan = buildRotationPlan(config(), '2026-10-26');
  const job = { ...plan.jobs[0], _id: { toString: () => '600000000000000000000001' } };
  const payload = buildRotationDispatchPayload(job, config({ metadata: { refrensLeadId: 'production-lead', sourceKey: 'gst_unassigned_leads' } }));
  assert.equal(payload.metadata.refrensLeadId, null);
  assert.equal(payload.metadata.sourceKey, 'rotational_calls');
  assert.equal(payload.metadata.rotationJobId, job._id.toString());
  const body = { 'customer-data': payload.metadata, 'call-summary': { call_status: 'call_not_picked' } };
  assert.equal(getRotationContext(body).isRotation, true);
  assert.equal(getRotationContext({ data: { metadata: payload.metadata } }).isRotation, true);
  assert.equal((await processCallSummary(body)).reason, 'rotational test call');
});

test('rotation API rejects missing/invalid authentication and dry-run never connects to Mongo', async t => {
  const oldToken = process.env.JOBS_API_TOKEN, oldConfig = process.env.ROTATIONAL_CALLS_CONFIG;
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const oldCwd = process.cwd();
  const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-auth-'));
  const app = require('../src/app');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    process.chdir(oldCwd);
    if (oldToken === undefined) delete process.env.JOBS_API_TOKEN; else process.env.JOBS_API_TOKEN = oldToken;
    if (oldConfig === undefined) delete process.env.ROTATIONAL_CALLS_CONFIG; else process.env.ROTATIONAL_CALLS_CONFIG = oldConfig;
    fs.rmdirSync(isolatedCwd);
  });
  process.chdir(isolatedCwd);
  process.env.ROTATIONAL_CALLS_CONFIG = JSON.stringify(config());
  const url = `http://127.0.0.1:${server.address().port}/jobs/rotation`;
  delete process.env.JOBS_API_TOKEN;
  assert.equal((await fetch(`${url}/preview`)).status, 503);
  process.env.JOBS_API_TOKEN = 'rotation-test-only';
  assert.equal((await fetch(`${url}/preview`)).status, 401);
  const headers = { 'x-jobs-api-token': 'rotation-test-only', 'Content-Type': 'application/json' };
  const preview = await fetch(`${url}/run`, { method: 'POST', headers, body: '{}' });
  assert.equal(preview.status, 200);
  const result = await preview.json();
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.total, 20);
  assert.equal((await fetch(`${url}/run`, { method: 'POST', headers, body: '{"dryRun":false}' })).status, 400);
  assert.equal((await fetch(`${url}/run`, { method: 'POST', headers, body: '{"dryRun":"false"}' })).status, 400);
});
