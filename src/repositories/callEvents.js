const { ObjectId } = require('mongodb');
const { getCallEventsCollection, isMongoConfigured } = require('../services/mongo');
const logger = require('../utils/logger');

function getPayloadCallId(body) {
  return (
    body?.data?.callId ||
    body?.['customer-data']?.callId ||
    body?.['room-data']?.['session-id'] ||
    null
  );
}

function getWebhookType(body) {
  return body?.webhookType || (body?.['call-summary'] ? 'call-summary' : 'unknown');
}

function buildDedupeKey({ callId, webhookType, body }) {
  if (callId) {
    return `${webhookType}:${callId}`;
  }

  const fallbackId = body?.['room-data']?.['meeting-id'] || body?.data?.timestamp || new Date().toISOString();
  return `${webhookType}:unknown:${fallbackId}`;
}

async function saveIncomingWebhook(body) {
  if (!isMongoConfigured()) {
    logger.warn('MongoDB is not configured; incoming webhook was not persisted');
    return null;
  }

  const collection = await getCallEventsCollection();
  const callId = getPayloadCallId(body);
  const webhookType = getWebhookType(body);
  const dedupeKey = buildDedupeKey({ callId, webhookType, body });
  const now = new Date();

  await collection.updateOne(
    { dedupeKey },
    {
      $setOnInsert: {
        dedupeKey,
        callId,
        webhookType,
        source: 'videosdk',
        createdAt: now,
        processing: {
          status: 'received',
          attempts: 0,
          lastError: null,
          processedAt: null,
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
      },
      $set: {
        rawPayload: body,
        receivedAt: now,
        updatedAt: now,
      },
      $inc: {
        receivedCount: 1,
      },
    },
    { upsert: true },
  );

  return collection.findOne({ dedupeKey });
}

async function updateEvent(eventId, update) {
  if (!eventId || !isMongoConfigured()) {
    return;
  }

  const collection = await getCallEventsCollection();
  await collection.updateOne(
    { _id: new ObjectId(eventId) },
    {
      ...update,
      $set: {
        ...(update.$set || {}),
        updatedAt: new Date(),
      },
    },
  );
}

async function markEventIgnored(eventId, reason) {
  return updateEvent(eventId, {
    $set: {
      'processing.status': 'skipped',
      'processing.skipReason': reason,
      'processing.processedAt': new Date(),
    },
  });
}

async function markEventProcessing(eventId) {
  return updateEvent(eventId, {
    $set: {
      'processing.status': 'processing',
      'processing.lastError': null,
    },
    $inc: {
      'processing.attempts': 1,
    },
  });
}

async function markEventParsed(eventId, parsed, isPositiveCall) {
  return updateEvent(eventId, {
    $set: {
      parsed,
      isPositiveCall,
    },
  });
}

function extractRefrensLeadId(result) {
  return (
    result?.data?.data?.leadId ||
    result?.data?.leadId ||
    result?.data?.body?.data?.leadId ||
    null
  );
}

async function markLeadCreated(eventId, { externalId, requestPayload, result }) {
  return updateEvent(eventId, {
    $set: {
      'processing.status': 'processed',
      'processing.processedAt': new Date(),
      'processing.lastError': null,
      'refrens.attempted': true,
      'refrens.success': true,
      'refrens.action': result?.action || 'create-lead',
      'refrens.externalId': externalId,
      'refrens.leadId': extractRefrensLeadId(result),
      'refrens.statusCode': result?.status || null,
      'refrens.requestPayload': requestPayload,
      'refrens.responsePayload': result,
    },
  });
}

async function markLeadPatched(eventId, { leadId, requestPayload, result }) {
  return updateEvent(eventId, {
    $set: {
      'processing.status': 'processed',
      'processing.processedAt': new Date(),
      'processing.lastError': null,
      'refrens.attempted': true,
      'refrens.success': true,
      'refrens.action': result?.action || 'patch-lead',
      'refrens.externalId': result?.data?.data?.externalId || result?.data?.externalId || null,
      'refrens.leadId': leadId || extractRefrensLeadId(result),
      'refrens.statusCode': result?.status || null,
      'refrens.requestPayload': requestPayload,
      'refrens.responsePayload': result,
    },
  });
}

async function markLeadSkipped(eventId, reason) {
  return updateEvent(eventId, {
    $set: {
      'processing.status': 'skipped',
      'processing.skipReason': reason,
      'processing.processedAt': new Date(),
      'refrens.attempted': false,
      'refrens.success': false,
    },
  });
}

async function markLeadFailed(eventId, { externalId, leadId, requestPayload, error }) {
  return updateEvent(eventId, {
    $set: {
      'processing.status': 'failed',
      'processing.lastError': error?.message || 'Unknown Refrens error',
      'processing.processedAt': new Date(),
      'refrens.attempted': true,
      'refrens.success': false,
      'refrens.action': error?.action || null,
      'refrens.externalId': externalId || null,
      'refrens.leadId': leadId || error?.leadId || null,
      'refrens.statusCode': error?.response?.status || null,
      'refrens.requestPayload': requestPayload || null,
      'refrens.responsePayload': error?.response?.data || null,
    },
  });
}

module.exports = {
  getPayloadCallId,
  getWebhookType,
  saveIncomingWebhook,
  markEventIgnored,
  markEventProcessing,
  markEventParsed,
  markLeadCreated,
  markLeadPatched,
  markLeadSkipped,
  markLeadFailed,
};
