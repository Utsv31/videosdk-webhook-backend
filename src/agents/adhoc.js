const { buildBaseParsed, getConfiguredIds } = require('./common');

const ADHOC_AGENT_TYPE = 'adhoc';
const DEFAULT_ADHOC_AGENT_ID = 'ag_l901ju';
const LOST_REJECTED_RECOVERY = 'Lost_Rejected_Recovery';

function getAgentIds() {
  return getConfiguredIds('ADHOC_AGENT_ID', DEFAULT_ADHOC_AGENT_ID);
}

function matches({ summary, customerData, roomData }) {
  return Boolean(
    roomData.agentId && getAgentIds().has(roomData.agentId),
  ) || (customerData.campaign || summary.campaign) === LOST_REJECTED_RECOVERY;
}

function parseLostRejectedRecovery(context) {
  const { summary } = context;

  return {
    ...buildBaseParsed({
      ...context,
      agent: module.exports,
    }),
    callOutcome: summary.call_outcome,
    interestLevel: summary.interest_level,
    offerIntroduced: summary.offer_introduced,
    offerInterest: summary.offer_interest,
    salesCallbackRequired: summary.sales_callback_required === true,
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

  if (campaign === LOST_REJECTED_RECOVERY) {
    return parseLostRejectedRecovery(context);
  }

  return {
    ...parseLostRejectedRecovery(context),
    campaign,
  };
}

module.exports = {
  DEFAULT_ADHOC_AGENT_ID,
  LOST_REJECTED_RECOVERY,
  getAgentIds,
  matches,
  parse,
  type: ADHOC_AGENT_TYPE,
};
