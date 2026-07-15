const {
  buildBaseParsed,
  getConfiguredIds,
  normalizeEnumValue,
  normalizeYesNo,
} = require('./common');

const GST_AGENT_TYPE = 'gst';
const DEFAULT_GST_AGENT_ID = 'ag_n8irvh';
const DEFAULT_GST_SIP_CALL_FROM = '+918035017510';

function getAgentIds() {
  return getConfiguredIds('GST_AGENT_ID', DEFAULT_GST_AGENT_ID);
}

function getDefaultCallerPhone() {
  return process.env.GST_SIP_CALL_FROM || DEFAULT_GST_SIP_CALL_FROM;
}

function hasSummaryShape(summary) {
  return Boolean(
    summary.call_status ||
    summary.current_invoicing_platform ||
    summary.requirement_type ||
    summary.lead_priority,
  );
}

function matches({ summary, roomData }) {
  return Boolean(
    roomData.agentId && getAgentIds().has(roomData.agentId),
  ) || hasSummaryShape(summary);
}

function parse(context) {
  const { summary } = context;

  return {
    ...buildBaseParsed({
      ...context,
      agent: module.exports,
    }),
    gstCallStatus: normalizeEnumValue(summary.call_status),
    isRightBusiness: normalizeYesNo(summary.is_right_business),
    isNeedCallback: normalizeYesNo(summary.is_need_callback || summary.is_callback_needed),
    invoicingAndBilling: normalizeYesNo(summary.invoicing_and_billing),
    completeAccounting: normalizeYesNo(summary.complete_accounting),
    demoRequested: normalizeYesNo(summary.demo_requested),
    currentInvoicingPlatform: normalizeEnumValue(summary.current_invoicing_platform),
    requirementType: normalizeEnumValue(summary.requirement_type),
    businessNature: normalizeEnumValue(summary.business_nature),
    leadPriority: normalizeEnumValue(summary.lead_priority),
    businessAge: summary.business_age,
    businessDescription: summary.business_description,
    callSummaryText: summary.call_summary || summary.summary,
  };
}

module.exports = {
  DEFAULT_GST_AGENT_ID,
  DEFAULT_GST_SIP_CALL_FROM,
  getAgentIds,
  getDefaultCallerPhone,
  hasSummaryShape,
  matches,
  parse,
  type: GST_AGENT_TYPE,
};
