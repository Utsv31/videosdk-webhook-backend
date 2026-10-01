const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPatchLeadPayload,
  GST_PATCH_CONFIG,
  PROBLEM_LEADS_OUTREACH_CONFIG,
} = require('../src/handlers/crm');
const { buildOutboundDispatchPayload } = require('../src/workers/outboundCallWorker');
const {
  DEFAULT_PROBLEM_LEADS_CAMPAIGN,
  getProblemLeadsRetryDecision,
} = require('../src/handlers/gstRetry');

function problemLeadsOutreach(overrides = {}) {
  return {
    agentType: 'adhoc',
    campaign: PROBLEM_LEADS_OUTREACH_CONFIG.campaign,
    callId: 'call-1',
    callOutcome: null,
    offerInterest: null,
    salesCallbackRequired: false,
    ...overrides,
  };
}

test('positive problem-leads outreach moves the existing lead to the reopened stage', () => {
  const payload = buildPatchLeadPayload(problemLeadsOutreach({ callOutcome: 'Interested' }));

  assert.equal(payload.stage, '1.i Reopened from Rejected');
  assert.deepEqual(payload.tagsAdd, ['Voice AI attempt']);
  assert.equal(Object.hasOwn(payload, 'owner'), false);
  assert.equal(Object.hasOwn(payload, 'assignee'), false);
});

test('all configured positive signals use the reopened stage', () => {
  const cases = [
    { callOutcome: 'Callback Requested' },
    { callOutcome: 'Need Time' },
    { offerInterest: 'Interested' },
    { salesCallbackRequired: true },
  ];

  for (const positiveCase of cases) {
    const payload = buildPatchLeadPayload(problemLeadsOutreach(positiveCase));
    assert.equal(payload.stage, PROBLEM_LEADS_OUTREACH_CONFIG.stage);
    assert.deepEqual(payload.tagsAdd, ['Voice AI attempt']);
  }
});

test('problem-leads outreach adds normal identity and callback tags without reopened tag', () => {
  const payload = buildPatchLeadPayload(problemLeadsOutreach({
    callOutcome: 'Interested',
    isRightBusiness: 'yes',
    isNeedCallback: 'yes',
  }));

  assert.equal(payload.stage, PROBLEM_LEADS_OUTREACH_CONFIG.stage);
  assert.deepEqual(payload.tagsAdd, [
    'Voice AI attempt',
    'Identity confirmed',
    'Sales Person Callback',
  ]);
});

test('problem-leads outreach adds callback tag for demo requested', () => {
  const payload = buildPatchLeadPayload(problemLeadsOutreach({
    callOutcome: 'Interested',
    demoRequested: 'yes',
  }));

  assert.equal(payload.stage, PROBLEM_LEADS_OUTREACH_CONFIG.stage);
  assert.deepEqual(payload.tagsAdd, [
    'Voice AI attempt',
    'Sales Person Callback',
  ]);
});

test('unanswered problem-leads outreach leaves the current stage unchanged', () => {
  const payload = buildPatchLeadPayload(problemLeadsOutreach({ callOutcome: 'Call Not Picked' }));

  assert.equal(Object.hasOwn(payload, 'pipeline'), false);
  assert.equal(Object.hasOwn(payload, 'stage'), false);
  assert.deepEqual(payload.tagsAdd, ['Voice AI attempt']);
});

test('generic ad hoc routing remains unchanged', () => {
  const payload = buildPatchLeadPayload({
    agentType: 'adhoc',
    campaign: 'Another_Campaign',
    callId: 'call-2',
    callOutcome: 'Interested',
  });

  assert.equal(payload.stage, process.env.REFRENS_DEFAULT_STAGE || 'Contacted');
  assert.deepEqual(payload.tagsAdd, ['Voice AI attempt']);
});

test('GST routing remains unchanged', () => {
  const payload = buildPatchLeadPayload({
    agentType: 'gst',
    callId: 'call-3',
    isRightBusiness: 'yes',
    isNeedCallback: 'no',
  });

  assert.equal(payload.stage, GST_PATCH_CONFIG.stages.identityConfirmed);
  assert.ok(payload.tagsAdd.includes(GST_PATCH_CONFIG.tags.identityConfirmed));
});

test('problem-leads outbound job dispatches with ad hoc campaign metadata', () => {
  const payload = buildOutboundDispatchPayload({
    _id: { toString: () => 'job-1' },
    sourceKey: 'problem_leads_outreach',
    questionId: '4906',
    refrensLeadId: 'lead-1',
    phone: '+919999999999',
    name: 'Test User',
    businessName: 'Test Business',
    email: 'test@example.com',
    stage: 'Rejected',
  });

  assert.equal(payload.metadata.campaign, PROBLEM_LEADS_OUTREACH_CONFIG.campaign);
  assert.equal(payload.metadata.agentType, 'adhoc');
  assert.equal(payload.metadata.sourceKey, 'problem_leads_outreach');
  assert.equal(payload.sipCallTo, '+919999999999');
});

test('GST outbound job keeps GST routing defaults', () => {
  const payload = buildOutboundDispatchPayload({
    _id: { toString: () => 'job-2' },
    sourceKey: 'gst_unassigned_leads',
    questionId: '4645',
    refrensLeadId: 'lead-2',
    phone: '+918888888888',
  });

  assert.equal(payload.metadata.agentType, 'gst');
  assert.equal(Object.hasOwn(payload.metadata, 'campaign'), false);
  assert.equal(payload.routingRuleId, process.env.GST_ROUTING_RULE_ID || 'rr_fogwqz');
});

test('problem-leads no-answer summary schedules standard retry attempt 2', () => {
  const decision = getProblemLeadsRetryDecision(problemLeadsOutreach({
    callOutcome: 'No Answer',
    refrensLeadId: '6a0811f7e6df7f0031c97298',
    phone: '+919999999999',
    webhookUrl: 'https://example.com/webhook',
    sourceKey: 'problem_leads_outreach',
  }));

  assert.equal(decision.shouldRetry, true);
  assert.equal(decision.nextAttempt, 2);
  assert.equal(decision.retryFlow, 'standard');
  assert.equal(decision.delayMs, 2 * 60 * 1000);
  assert.equal(decision.dispatchPayload.metadata.campaign, DEFAULT_PROBLEM_LEADS_CAMPAIGN);
  assert.equal(decision.dispatchPayload.metadata.retryAttempt, 2);
});

test('problem-leads retry attempt 2 schedules final standard retry attempt 3', () => {
  const decision = getProblemLeadsRetryDecision(problemLeadsOutreach({
    callOutcome: 'Call Not Picked',
    retryAttempt: 2,
    refrensLeadId: '6a0811f7e6df7f0031c97298',
    phone: '+919999999999',
    webhookUrl: 'https://example.com/webhook',
    sourceKey: 'problem_leads_outreach',
  }));

  assert.equal(decision.shouldRetry, true);
  assert.equal(decision.nextAttempt, 3);
  assert.equal(decision.retryFlow, 'standard');
  assert.equal(decision.delayMs, 60 * 60 * 1000);
});

test('problem-leads positive or callback signals stop retries', () => {
  const base = {
    refrensLeadId: '6a0811f7e6df7f0031c97298',
    phone: '+919999999999',
    webhookUrl: 'https://example.com/webhook',
    sourceKey: 'problem_leads_outreach',
  };

  const positive = getProblemLeadsRetryDecision(problemLeadsOutreach({
    ...base,
    callOutcome: 'Interested',
  }));
  const callback = getProblemLeadsRetryDecision(problemLeadsOutreach({
    ...base,
    callOutcome: 'No Answer',
    isNeedCallback: 'yes',
  }));

  assert.equal(positive.shouldRetry, false);
  assert.equal(callback.shouldRetry, false);
});
