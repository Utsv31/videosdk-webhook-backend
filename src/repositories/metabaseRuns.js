const { ObjectId } = require('mongodb');
const { getMetabaseRunsCollection, isMongoConfigured } = require('../services/mongo');

async function createMetabaseRun({ sourceKey, questionId, requestedBy, parameters }) {
  if (!isMongoConfigured()) {
    return null;
  }

  const collection = await getMetabaseRunsCollection();
  const now = new Date();
  const result = await collection.insertOne({
    sourceKey,
    questionId,
    requestedBy: requestedBy || null,
    parameters: parameters || {},
    status: 'running',
    fetchedCount: 0,
    eligibleCount: 0,
    skippedCount: 0,
    queuedCount: 0,
    error: null,
    startedAt: now,
    updatedAt: now,
  });

  return collection.findOne({ _id: result.insertedId });
}

async function updateMetabaseRun(runId, update) {
  if (!runId || !isMongoConfigured()) {
    return;
  }

  const collection = await getMetabaseRunsCollection();
  await collection.updateOne(
    { _id: new ObjectId(runId) },
    {
      ...update,
      $set: {
        ...(update.$set || {}),
        updatedAt: new Date(),
      },
    },
  );
}

async function markMetabaseRunCompleted(runId, stats) {
  return updateMetabaseRun(runId, {
    $set: {
      status: 'completed',
      fetchedCount: stats.fetchedCount || 0,
      eligibleCount: stats.eligibleCount || 0,
      skippedCount: stats.skippedCount || 0,
      queuedCount: stats.queuedCount || 0,
      completedAt: new Date(),
      error: null,
    },
  });
}

async function markMetabaseRunFailed(runId, error) {
  return updateMetabaseRun(runId, {
    $set: {
      status: 'failed',
      failedAt: new Date(),
      error: {
        message: error?.message || 'Unknown Metabase run error',
        status: error?.response?.status || null,
        response: error?.response?.data || null,
      },
    },
  });
}

module.exports = {
  createMetabaseRun,
  markMetabaseRunCompleted,
  markMetabaseRunFailed,
  updateMetabaseRun,
};
