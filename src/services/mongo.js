const { MongoClient } = require('mongodb');
const logger = require('../utils/logger');

let client;
let db;
let indexesReady = false;
let retryIndexesReady = false;
let metabaseRunIndexesReady = false;
let outboundJobIndexesReady = false;

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
    await collection.createIndex({ outboundJobId: 1, webhookType: 1 });
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

async function getMetabaseRunsCollection() {
  const database = await getDb();

  if (!database) {
    return null;
  }

  const collectionName = process.env.MONGODB_METABASE_RUNS_COLLECTION || 'metabase_runs';
  const collection = database.collection(collectionName);

  if (!metabaseRunIndexesReady) {
    await collection.createIndex({ sourceKey: 1, startedAt: -1 });
    await collection.createIndex({ status: 1, startedAt: -1 });
    metabaseRunIndexesReady = true;
  }

  return collection;
}

async function getOutboundCallJobsCollection() {
  const database = await getDb();

  if (!database) {
    return null;
  }

  const collectionName = process.env.MONGODB_OUTBOUND_CALL_JOBS_COLLECTION || 'outbound_call_jobs';
  const collection = database.collection(collectionName);

  if (!outboundJobIndexesReady) {
    await collection.createIndex({ dedupeKey: 1 }, { unique: true });
    await collection.createIndex({ status: 1, scheduledAt: 1 });
    await collection.createIndex({ sourceKey: 1, refrensLeadId: 1, active: 1 });
    await collection.createIndex({ refrensLeadId: 1, createdAt: -1 });
    await collection.createIndex({ outboundJobId: 1 });
    await collection.createIndex({ callId: 1 });
    await collection.createIndex({ roomId: 1 });
    outboundJobIndexesReady = true;
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
    metabaseRunIndexesReady = false;
    outboundJobIndexesReady = false;
  }
}

module.exports = {
  isMongoConfigured,
  getDb,
  getCallEventsCollection,
  getRetryJobsCollection,
  getMetabaseRunsCollection,
  getOutboundCallJobsCollection,
  closeMongo,
};
