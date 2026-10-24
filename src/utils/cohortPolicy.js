const PROBLEM_LEADS_SOURCE_KEY = 'problem_leads_outreach';

function allowsAssignedCalls(sourceKey) {
  return sourceKey === PROBLEM_LEADS_SOURCE_KEY;
}

function getRetrySourceKey(job) {
  return job.dispatchPayload?.metadata?.sourceKey || job.sourceKey;
}

module.exports = {
  allowsAssignedCalls,
  getRetrySourceKey,
};
