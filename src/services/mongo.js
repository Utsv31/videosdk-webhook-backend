const { MongoClient } = require('mongodb');
const logger = require('../utils/logger');

let client;
let db;
let indexesReady = false;
let retryIndexesReady = false;

function isMongoConfigured() {
  return Boolean(process.env.MONGODB_URI);
}

async function getDb() {
  if (!isMongoConfigured()) {
    return null;
  }

  if (db) {
    return db;
  }

  client = new MongoClient(process.env.MONGODB_URI, {
    maxPoolSize: 10,
  });

  await client.connect();

  const dbName = process.env.MONGODB_DB_NAME || 'videosdk_crm';
  db = client.db(dbName);

  logger.info('Connected to MongoDB', {
    dbName,
  });

  return db;
}

async function getCallEventsCollection() {
  const database = await getDb();

  if (!database) {
    return null;
  }

  const collectionName = process.env.MONGODB_EVENTS_COLLECTION || 'call_events';
  const collection = database.collection(collectionName);

  if (!indexesReady) {
    await collection.createIndex({ dedupeKey: 1 }, { unique: true });
    await collection.createIndex({ callId: 1, webhookType: 1 });
    await collection.createIndex({ roomId: 1, webhookType: 1 });
    await collection.createIndex({ refrensLeadId: 1, receivedAt: -1 });
    await collection.createIndex({ 'processing.status': 1, receivedAt: 1 });
    indexesReady = true;
  }

  return collection;
}

async function getRetryJobsCollection() {
  const database = await getDb();

  if (!database) {
    return null;
  }

  const collectionName = process.env.MONGODB_RETRY_JOBS_COLLECTION || 'call_retry_jobs';
  const collection = database.collection(collectionName);

  if (!retryIndexesReady) {
    await collection.createIndex({ dedupeKey: 1 }, { unique: true });
    await collection.createIndex({ status: 1, scheduledAt: 1 });
    await collection.createIndex({ callId: 1, agentType: 1 });
    retryIndexesReady = true;
  }

  return collection;
}

async function closeMongo() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    indexesReady = false;
    retryIndexesReady = false;
  }
}

module.exports = {
  isMongoConfigured,
  getDb,
  getCallEventsCollection,
  getRetryJobsCollection,
  closeMongo,
};
