const adhoc = require('./adhoc');
const gst = require('./gst');

const agents = [
  gst,
  adhoc,
];

function getPayloadParts(body) {
  return {
    body: body || {},
    summary: body?.['call-summary'] || {},
    customerData: body?.['customer-data'] || {},
    roomData: body?.['room-data'] || {},
  };
}

function getAgentForPayload(context) {
  const byAgentId = agents.find((agent) => (
    context.roomData.agentId && agent.getAgentIds?.().has(context.roomData.agentId)
  ));

  if (byAgentId) {
    return byAgentId;
  }

  return agents.find((agent) => agent.matches(context)) || adhoc;
}

function parsePayload(body) {
  const context = getPayloadParts(body);
  const agent = getAgentForPayload(context);

  return agent.parse(context);
}

module.exports = {
  agents,
  adhoc,
  getAgentForPayload,
  getPayloadParts,
  gst,
  parsePayload,
};
