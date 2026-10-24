const test = require('node:test');
const assert = require('node:assert/strict');
const { allowsAssignedCalls, getRetrySourceKey } = require('../src/utils/cohortPolicy');
const { parsePayload } = require('../src/agents');
const { buildPatchLeadPayload } = require('../src/handlers/crm');
const { getProblemLeadsRetryDecision } = require('../src/handlers/gstRetry');
const { migrationFor } = require('../scripts/recoverAssignedProblemLeadRetries');
const { ObjectId } = require('mongodb');

test('assignment exception is limited to the Never Able cohort', () => {
  assert.equal(allowsAssignedCalls('problem_leads_outreach'), true);
  for (const source of ['gst_unassigned_leads', 'another_campaign', undefined]) {
    assert.equal(allowsAssignedCalls(source), false);
  }
  assert.equal(getRetrySourceKey({
    sourceKey: 'gst_unassigned_leads',
    dispatchPayload: { metadata: { sourceKey: 'problem_leads_outreach' } },
  }), 'problem_leads_outreach');
});

function recoveredSummary(summary, retryAttempt = 2) {
  return parsePayload({
    'call-summary': summary,
    'customer-data': {
      refrensLeadId: '6a0811f7e6df7f0031c97298',
      outboundJobId: '6adc667e1eb0efbb79316e6c',
      callId: 'recovered-call',
      sipCallFrom: '+918031729970',
      sipCallTo: '+919999999999',
      routingRuleId: 'rr-original',
      sourceKey: 'problem_leads_outreach',
      campaign: 'Reach_Out_Problem_Leads',
      retryAttempt,
      webhook_url: 'https://example.com/webhook',
    },
    'room-data': { agentId: 'ag_n8irvh' },
  });
}

test('recovered GST-shaped summary continues the Never Able final retry without resetting attempts or route', () => {
  const parsed = recoveredSummary({ call_status: 'call_not_picked' });
  const decision = getProblemLeadsRetryDecision(parsed);
  assert.equal(parsed.agentType, 'adhoc');
  assert.equal(decision.nextAttempt, 3);
  assert.equal(decision.delayMs, 60 * 60 * 1000);
  assert.equal(decision.dispatchPayload.routingRuleId, 'rr-original');
  assert.equal(decision.dispatchPayload.sipCallFrom, '+918031729970');
  assert.equal(decision.dispatchPayload.metadata.sourceKey, 'problem_leads_outreach');
  assert.equal(decision.dispatchPayload.metadata.outboundJobId, '6adc667e1eb0efbb79316e6c');
  assert.equal(decision.dispatchPayload.metadata.routingRuleId, 'rr-original');
  assert.equal(getProblemLeadsRetryDecision(recoveredSummary({ call_status: 'call_not_picked' }, 3)).shouldRetry, false);
});

test('recovered positive summary reopens lead and stops further retries', () => {
  for (const signal of [{ is_right_business: 'yes' }, { is_need_callback: 'yes' }, { demo_requested: 'yes' }]) {
    const parsed = recoveredSummary({ call_status: 'successful', summary: 'Customer response.', ...signal });
    assert.equal(getProblemLeadsRetryDecision(parsed).shouldRetry, false);
    const patch = buildPatchLeadPayload(parsed);
    assert.equal(patch.stage, '1.i Reopened from Rejected');
    assert.ok(patch.tagsAdd.includes('Voice AI attempt'));
  }
  const patch = buildPatchLeadPayload(recoveredSummary({ call_status: 'call_not_picked', summary: 'Not picked up.' }));
  assert.equal(Object.hasOwn(patch, 'stage'), false);
});

test('recovery retains original SIP payload and rejects a positive source call', () => {
  const retry = {
    refrensLeadId: '6a0811f7e6df7f0031c97298', retryAttempt: 2,
    dispatchPayload: { sipCallFrom: '+918031729970', sipCallTo: '+919999999999', routingRuleId: 'rr-original', metadata: { retryAttempt: 2, retryFlow: 'standard' } },
  };
  const outbound = { _id: new ObjectId(), runId: new ObjectId() };
  const event = { parsed: { ...recoveredSummary({ call_status: 'call_not_picked' }, 1), gstCallStatus: 'call_not_picked' } };
  const result = migrationFor({ retry, outbound, event, scheduledAt: new Date() });
  assert.equal(result.dispatchPayload.routingRuleId, retry.dispatchPayload.routingRuleId);
  assert.equal(result.dispatchPayload.sipCallFrom, retry.dispatchPayload.sipCallFrom);
  assert.equal(result.dispatchPayload.metadata.retryAttempt, 2);
  assert.equal(result.dispatchPayload.metadata.campaign, 'Reach_Out_Problem_Leads');
  assert.throws(() => migrationFor({ retry, outbound, event: { parsed: { ...event.parsed, isRightBusiness: 'yes' } }, scheduledAt: new Date() }), /no longer qualifies/);
});
