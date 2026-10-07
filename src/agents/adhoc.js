const {
  buildBaseParsed,
  getConfiguredIds,
  normalizeEnumValue,
  normalizeYesNo,
} = require('./common');

const ADHOC_AGENT_TYPE = 'adhoc';
const DEFAULT_ADHOC_AGENT_ID = 'ag_l901ju';
const REACH_OUT_PROBLEM_LEADS = 'Reach_Out_Problem_Leads';

function getAgentIds() {
  return getConfiguredIds('ADHOC_AGENT_ID', DEFAULT_ADHOC_AGENT_ID);
}

function matches({ summary, customerData, roomData }) {
  return Boolean(
    roomData.agentId && getAgentIds().has(roomData.agentId),
  ) || (customerData.campaign || summary.campaign) === REACH_OUT_PROBLEM_LEADS;
}

function parseReachOutProblemLeads(context) {
  const { summary } = context;

  return {
    ...buildBaseParsed({
      ...context,
      agent: module.exports,
    }),
    callOutcome: summary.call_outcome,
    callStatus: normalizeEnumValue(summary.call_status),
    interestLevel: summary.interest_level,
    offerIntroduced: summary.offer_introduced,
    offerInterest: summary.offer_interest,
    salesCallbackRequired: summary.sales_callback_required === true,
    isRightBusiness: normalizeYesNo(
      summary.is_right_business ||
      summary.identity_confirmed ||
      summary.right_business,
    ),
    isNeedCallback: normalizeYesNo(
      summary.is_need_callback ||
      summary.is_callback_needed ||
      summary.sales_callback_required,
    ),
    demoRequested: normalizeYesNo(summary.demo_requested),
    callbackTime: summary.callback_time,
    customerSentiment: summary.customer_sentiment,
    originalObjection: summary.original_objection,
    currentSolution: summary.current_solution,
    currentNeed: summary.current_need,
    importantNotes: summary.important_notes,
    recommendedAction: summary.recommended_action,
    callSummaryText: summary.call_summary || summary.summary,
  };
}

function parse(context) {
  const campaign = context.customerData.campaign || context.summary.campaign;

  if (campaign === REACH_OUT_PROBLEM_LEADS) {
    return parseReachOutProblemLeads(context);
  }

  return {
    ...parseReachOutProblemLeads(context),
    campaign,
  };
}

module.exports = {
  DEFAULT_ADHOC_AGENT_ID,
  REACH_OUT_PROBLEM_LEADS,
  getAgentIds,
  matches,
  parse,
  type: ADHOC_AGENT_TYPE,
};
