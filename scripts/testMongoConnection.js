require('dotenv').config();

const { getCallEventsCollection, closeMongo } = require('../src/services/mongo');

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not configured. Add it to .env before running this script.');
  }

  const collection = await getCallEventsCollection();
  const now = new Date();

  const doc = {
    dedupeKey: `manual-test:${now.toISOString()}`,
    callId: `manual-test-${now.getTime()}`,
    webhookType: 'manual-test',
    source: 'manual',
    rawPayload: {
      message: 'MongoDB connection test placeholder',
    },
    parsed: {
      customerName: 'Mongo Test User',
      callOutcome: 'Interested',
      interestLevel: 'Hot',
    },
    isPositiveCall: true,
    processing: {
      status: 'test_inserted',
      attempts: 0,
      lastError: null,
      processedAt: now,
    },
    refrens: {
      attempted: false,
      success: false,
      action: null,
      externalId: null,
      leadId: null,
      statusCode: null,
      requestPayload: null,
      responsePayload: null,
    },
    receivedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const result = await collection.insertOne(doc);

  console.log(JSON.stringify({
    success: true,
    insertedId: result.insertedId,
    database: process.env.MONGODB_DB_NAME || 'videosdk_crm',
    collection: process.env.MONGODB_EVENTS_COLLECTION || 'call_events',
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      success: false,
      message: error.message,
      stack: error.stack,
    }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMongo();
  });
