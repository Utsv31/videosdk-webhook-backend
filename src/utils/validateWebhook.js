const crypto = require('crypto');

function normalizeSignature(signature) {
  if (!signature) {
    return '';
  }

  return signature.startsWith('sha256=')
    ? signature.slice('sha256='.length)
    : signature;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function validateWebhook(req) {
  const secret = process.env.VIDEOSDK_WEBHOOK_SECRET;

  if (!secret) {
    return {
      valid: true,
      reason: 'signature validation disabled',
    };
  }

  const signature = normalizeSignature(req.get('x-videosdk-signature'));

  if (!signature) {
    return {
      valid: false,
      reason: 'missing x-videosdk-signature header',
    };
  }

  const body = req.rawBody || JSON.stringify(req.body || {});
  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  return {
    valid: safeEqual(signature, expected),
    reason: safeEqual(signature, expected) ? 'valid signature' : 'invalid signature',
  };
}

module.exports = validateWebhook;
