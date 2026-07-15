function normalizeEnumValue(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

function normalizeYesNo(value) {
  const normalized = normalizeEnumValue(value);
  return normalized === 'true' ? 'yes' : normalized === 'false' ? 'no' : normalized;
}

function normalizeRefrensLeadId(value) {
  if (!value) {
    return null;
  }

  const leadId = String(value).trim();
  return /^[a-f\d]{24}$/i.test(leadId) ? leadId : null;
}

function getRefrensLeadId(customerData, roomData, body) {
  return normalizeRefrensLeadId(
    customerData.refrensLeadId ||
    customerData.crm_lead_id ||
    customerData.leadId ||
    customerData.metaData?.refrensLeadId ||
    customerData.metaData?.crm_lead_id ||
    roomData.refrensLeadId ||
    body?.data?.metaData?.refrensLeadId ||
    body?.data?.metaData?.crm_lead_id,
  );
}

function getConfiguredIds(envName, defaultValue) {
  return new Set(
    (process.env[envName] || defaultValue)
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

function buildBaseParsed({ body, summary, customerData, roomData, agent }) {
  return {
    callId: customerData.callId,
    customerName: customerData.name,
    businessName: customerData.business_name,
    phone: customerData.sipCallTo,
    callerPhone: customerData.sipCallFrom || agent.getDefaultCallerPhone?.() || null,
    webhookUrl: customerData.webhook_url,
    routingRuleId: customerData.routingRuleId || customerData.routing_rule_id,
    retryAttempt: customerData.retryAttempt || customerData.retry_attempt,
    retryFlow: customerData.retryFlow || customerData.retry_flow,
    ageOfBusiness: customerData.age_of_business,
    campaign: customerData.campaign || summary.campaign,
    agentType: agent.type,
    agentId: roomData.agentId,
    meetingId: roomData['meeting-id'],
    sessionId: roomData['session-id'],
    refrensLeadId: getRefrensLeadId(customerData, roomData, body),
  };
}

module.exports = {
  buildBaseParsed,
  getConfiguredIds,
  getRefrensLeadId,
  normalizeEnumValue,
  normalizeRefrensLeadId,
  normalizeYesNo,
};
