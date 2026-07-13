const express = require('express');
const { processCallSummary, isCallSummaryPayload } = require('../handlers/callSummary');
const {
  getPayloadCallId,
  getWebhookType,
  saveIncomingWebhook,
  markEventIgnored,
  markEventProcessing,
} = require('../repositories/callEvents');
const validateWebhook = require('../utils/validateWebhook');
const logger = require('../utils/logger');

const router = express.Router();

router.post('/', (req, res) => {
  const body = req.body || {};
  const callId = getPayloadCallId(body);
  const webhookType = getWebhookType(body);

  logger.info('Incoming VideoSDK webhook', {
    callId,
    webhookType,
    receivedAt: new Date().toISOString(),
    payload: body,
  });

  res.status(200).json({
    success: true,
    received: true,
  });

  setImmediate(async () => {
    let eventRecord = null;

    try {
      eventRecord = await saveIncomingWebhook(body);
      const eventId = eventRecord?._id?.toString();
      const validation = validateWebhook(req);

      if (!validation.valid) {
        logger.warn('Webhook signature validation failed; skipping processing', {
          callId,
          reason: validation.reason,
        });
        await markEventIgnored(eventId, `signature validation failed: ${validation.reason}`);
        return;
      }

      if (webhookType === 'call-started' || webhookType === 'call-hangup') {
        logger.info('Ignoring non-summary webhook', {
          callId,
          webhookType,
        });
        await markEventIgnored(eventId, `ignored ${webhookType}`);
        return;
      }

      if (!isCallSummaryPayload(body)) {
        logger.warn('Ignoring unknown webhook payload shape', {
          callId,
          keys: Object.keys(body),
        });
        await markEventIgnored(eventId, 'unknown payload shape');
        return;
      }

      await markEventProcessing(eventId);
      await processCallSummary(body, { eventId });
    } catch (error) {
      logger.error('Async webhook processing failed', {
        callId,
        message: error.message,
        stack: error.stack,
      });
    }
  });
});

module.exports = router;
