const crypto = require('node:crypto');
const { readSecret } = require('./secrets');
const defaults = require('../../config/rotationalCalls.json');

const WORKFLOW = 'four_number_rotation';
const SOURCE_KEY = 'rotational_calls';
const IST_OFFSET_MS = 330 * 60 * 1000;
const PHONE = /^\+[1-9]\d{7,14}$/;

function configError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function getRotationConfig() {
  const secret = readSecret('ROTATIONAL_CALLS_CONFIG', {
    defaultFileNames: ['rotational_calls.json'],
  });
  try {
    const supplied = secret ? JSON.parse(secret) : {};
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('Invalid object');
    return { ...defaults, ...supplied };
  } catch {
    throw configError('Rotational calling configuration must be valid JSON');
  }
}

function validateRotationConfig(config, { live = false } = {}) {
  if (typeof config.enabled !== 'boolean' || typeof config.consentConfirmed !== 'boolean') {
    throw configError('enabled and consentConfirmed must be booleans');
  }
  if (!['total', 'per_recipient'].includes(config.dailyLimitMode)
    || !Number.isInteger(config.dailyCalls) || config.dailyCalls < 1 || config.dailyCalls > 10) {
    throw configError('dailyCalls must be 1-10; dailyLimitMode must be total or per_recipient');
  }
  if (!Number.isInteger(config.startHourIst) || !Number.isInteger(config.endHourIst)
    || config.startHourIst < 9 || config.endHourIst > 21 || config.startHourIst >= config.endHourIst) {
    throw configError('Call window must be within 09:00-21:00 Asia/Kolkata');
  }
  if (!Number.isFinite(config.minimumGapMinutes) || config.minimumGapMinutes < 5) {
    throw configError('minimumGapMinutes must be at least 5');
  }
  if (!Array.isArray(config.recipients) || config.recipients.length !== 4
    || config.recipients.some(r => !r || !PHONE.test(r.phone))
    || new Set(config.recipients.map(r => r.phone)).size !== 4) {
    throw configError('Configure exactly four distinct recipients with E.164 phone numbers');
  }
  if (!Array.isArray(config.callerRoutes) || config.callerRoutes.length !== 2
    || config.callerRoutes.some(r => !r || !PHONE.test(r.sipCallFrom) || !/^rr_[A-Za-z0-9_-]+$/.test(r.routingRuleId))
    || new Set(config.callerRoutes.map(r => r.sipCallFrom)).size !== 2) {
    throw configError('Configure two distinct SIP caller numbers, each with a routingRuleId');
  }
  if (!config.metadata || typeof config.metadata !== 'object' || Array.isArray(config.metadata)) {
    throw configError('metadata must be an object');
  }
  if (live && (config.enabled !== true || config.consentConfirmed !== true)) {
    throw configError('Live rotation requires enabled=true and consentConfirmed=true');
  }
}

function istDate(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function dayStart(date, hour) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw configError('date must use YYYY-MM-DD');
  const start = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== date) {
    throw configError('Invalid calendar date');
  }
  return new Date(start.getTime() + hour * 3600000 - IST_OFFSET_MS);
}

function configFingerprint(config) {
  const { enabled, consentConfirmed, ...schedule } = config;
  return crypto.createHash('sha256').update(JSON.stringify(schedule)).digest('hex');
}

function buildRotationPlan(config, date = istDate()) {
  validateRotationConfig(config);
  const startsAt = dayStart(date, config.startHourIst);
  const endsAt = dayStart(date, config.endHourIst);
  const total = config.dailyCalls * (config.dailyLimitMode === 'per_recipient' ? 4 : 1);
  const stepMs = Math.floor((endsAt - startsAt) / total);
  if (stepMs < config.minimumGapMinutes * 60000) {
    throw configError('Daily call count does not fit the configured minimum gap and window');
  }
  const id = `${WORKFLOW}:${date}`;
  const jobs = Array.from({ length: total }, (_, index) => {
    const recipient = config.recipients[index % 4];
    // Flip the caller on each four-recipient round so each recipient uses both routes.
    const route = config.callerRoutes[(index + Math.floor(index / 4)) % 2];
    return {
      planId: id, dedupeKey: `${id}:${index}`, sourceKey: SOURCE_KEY, dateIst: date,
      slot: index, recipientName: recipient.name || '', phone: recipient.phone,
      sipCallFrom: route.sipCallFrom, routingRuleId: route.routingRuleId,
      scheduledAt: new Date(startsAt.getTime() + index * stepMs),
      expiresAt: new Date(startsAt.getTime() + (index + 1) * stepMs),
    };
  });
  return { _id: id, workflow: WORKFLOW, dateIst: date, startsAt, endsAt, total, fingerprint: configFingerprint(config), jobs };
}

function getRotationContext(body) {
  const metadata = body?.['customer-data'] || body?.data?.metaData || body?.data?.metadata || {};
  return { jobId: metadata.rotationJobId || null, isRotation: metadata.sourceKey === SOURCE_KEY || Boolean(metadata.rotationJobId) };
}

module.exports = { WORKFLOW, SOURCE_KEY, buildRotationPlan, configError, configFingerprint, getRotationConfig, getRotationContext, istDate, validateRotationConfig };
