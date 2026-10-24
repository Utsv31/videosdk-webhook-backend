const assert = require('node:assert/strict');
const { MongoClient, ObjectId } = require('mongodb');

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('Supply MONGODB_URI for an isolated test database');
  const dbName = `videosdk_policy_test_${Date.now()}`;
  process.env.MONGODB_DB_NAME = dbName;
  process.env.REFRENS_API_BASE_URL = 'http://127.0.0.1:4905/refrens';
  process.env.REFRENS_BUSINESS_SLUG = 'policy-test';
  process.env.REFRENS_AUTH_MODE = 'static_token';
  process.env.REFRENS_API_KEY = 'simulation-only';
  process.env.VIDEOSDK_API_BASE_URL = 'http://127.0.0.1:4905/videosdk';
  process.env.VIDEOSDK_AUTH_TOKEN = 'simulation-only';
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db(dbName);
  try {
    const collection = db.collection('call_retry_jobs');
    const cases = [
      { leadId: '600000000000000000000001', sourceKey: 'problem_leads_outreach', expected: 'dispatched' },
      { leadId: '600000000000000000000002', sourceKey: 'gst_unassigned_leads', expected: 'skipped_before_dispatch' },
      { leadId: '600000000000000000000003', sourceKey: 'problem_leads_outreach', expected: 'skipped_before_dispatch' },
    ];
    const documents = cases.map((item) => ({
      _id: new ObjectId(), dedupeKey: `simulation:${item.leadId}`, refrensLeadId: item.leadId,
      status: 'scheduled', scheduledAt: new Date(Date.now() - 1000), createdAt: new Date(),
      retryAttempt: 2, dispatchAttempts: 0,
      dispatchPayload: { sipCallFrom: '+919000000001', sipCallTo: '+919000000002', routingRuleId: 'rr-simulation', metadata: { sourceKey: item.sourceKey, retryAttempt: 2 } },
    }));
    await collection.insertMany(documents);
    await require('../src/workers/retryWorker').processDueRetryJobs();
    const results = await collection.find({}).toArray();
    for (const item of cases) {
      assert.equal(results.find((row) => row.refrensLeadId === item.leadId).status, item.expected);
    }
    assert.match(results[1].closeReason, /assigned/);
    assert.match(results[2].closeReason, /blocking tag/);
    const outboundCollection = db.collection('outbound_call_jobs');
    await outboundCollection.insertMany(cases.map((item) => ({
      _id: new ObjectId(), dedupeKey: `simulation:${item.leadId}`, refrensLeadId: item.leadId,
      sourceKey: item.sourceKey, status: 'scheduled', active: true,
      scheduledAt: new Date(Date.now() - 1000), createdAt: new Date(),
      phone: '+919000000002', questionId: 'simulation', dispatchAttempts: 0,
    })));
    for (const item of cases) {
      await require('../src/workers/outboundCallWorker').processOutboundCallJobs();
    }
    const outbound = await outboundCollection.find({}).toArray();
    for (const item of cases) {
      assert.equal(outbound.find((row) => row.refrensLeadId === item.leadId).status, item.expected);
    }
    console.log(JSON.stringify({ verified: true, database: dbName, retries: results.map((row) => ({ leadId: row.refrensLeadId, status: row.status, closeReason: row.closeReason })), outbound: outbound.map((row) => ({ leadId: row.refrensLeadId, status: row.status, closeReason: row.closeReason })) }));
  } finally {
    await require('../src/services/mongo').closeMongo();
    await db.collection('call_retry_jobs').deleteMany({ dedupeKey: /^simulation:/ });
    await db.collection('outbound_call_jobs').deleteMany({ dedupeKey: /^simulation:/ });
    await client.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
