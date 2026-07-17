# VideoSDK Webhook Backend

Node.js/Express backend for listening to VideoSDK call webhooks and updating existing Refrens CRM leads from call summaries.

AiSensy/WhatsApp is intentionally disabled for now. The current flow focuses only on webhook listening and Refrens CRM lead creation.

## Flow

1. VideoSDK sends `POST /webhook`.
2. The server responds `200` immediately so VideoSDK does not retry.
3. `call-started` and `call-hangup` events are logged and ignored.
4. Every webhook is saved to MongoDB in `call_events`.
5. A payload containing `body["call-summary"]` is parsed asynchronously.
6. The backend updates MongoDB with parsed summary data and positive-call decision.
7. If the summary contains a valid `refrensLeadId`, the backend verifies the lead exists and patches that existing Refrens lead.
8. If the supplied `refrensLeadId` is not found, the event is stored and skipped.
9. If no `refrensLeadId` exists, the event is stored and skipped.
10. The backend updates MongoDB with the Refrens action, request/response, status code, and error if any.

## Positive Call Criteria

The legacy positive-call detector still parses these values for audit/debugging:

- `call_outcome` is `Interested`
- `call_outcome` is `Callback Requested`
- `call_outcome` is `Need Time`
- `offer_interest` is `Interested`
- `sales_callback_required` is `true`

These rules live in `src/handlers/callSummary.js` in `isPositiveCall()`, but current ad hoc and GST flows are patch-only and do not create fallback leads.

## Install

```bash
cd videosdk-webhook-backend
npm install
```

## Configure

Copy `.env.example` to `.env` and fill in real values:

```bash
cp .env.example .env
```

Required values:

```env
PORT=3000
REFRENS_API_KEY=
REFRENS_API_BASE_URL=https://api.refrens.com
REFRENS_BUSINESS_SLUG=crm-lead-create
REFRENS_DEFAULT_PIPELINE=Sales Pipeline
REFRENS_DEFAULT_STAGE=Contacted
GST_AGENT_ID=ag_n8irvh
GST_SIP_CALL_FROM=+918035017510
GST_ROUTING_RULE_ID=rr_fogwqz
ADHOC_AGENT_ID=ag_l901ju
VIDEOSDK_AUTH_TOKEN=
VIDEOSDK_API_BASE_URL=https://api.videosdk.live
VIDEOSDK_WEBHOOK_URL=https://videosdk-webhook-backend.onrender.com/webhook
RETRY_WORKER_ENABLED=true
RETRY_WORKER_INTERVAL_MS=60000
OUTBOUND_CALL_WORKER_ENABLED=true
OUTBOUND_CALL_WORKER_INTERVAL_MS=2000
OUTBOUND_CALL_WEBHOOK_TIMEOUT_MS=360000
OUTBOUND_CALL_MAX_DISPATCH_ATTEMPTS=2
CALL_WINDOW_START_HOUR_IST=9
CALL_WINDOW_END_HOUR_IST=21
METABASE_URL=https://metabase-proded4fa3ab.azurewebsites.net
METABASE_API_KEY=
METABASE_GST_UNASSIGNED_QUESTION_ID=4645
JOBS_API_TOKEN=
MONGODB_URI=mongodb+srv://<db_username>:<db_password>@cluster0.qdrculk.mongodb.net/videosdk_crm?retryWrites=true&w=majority&appName=Cluster0
MONGODB_DB_NAME=videosdk_crm
MONGODB_EVENTS_COLLECTION=call_events
MONGODB_RETRY_JOBS_COLLECTION=call_retry_jobs
MONGODB_METABASE_RUNS_COLLECTION=metabase_runs
MONGODB_OUTBOUND_CALL_JOBS_COLLECTION=outbound_call_jobs
```

Optional:

```env
VIDEOSDK_WEBHOOK_SECRET=
METABASE_SESSION_TOKEN=
```

If `VIDEOSDK_WEBHOOK_SECRET` is set, the server expects an `x-videosdk-signature` HMAC SHA-256 signature. If VideoSDK uses a different signature scheme, update `src/utils/validateWebhook.js`.

## Run Locally

```bash
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

Webhook URL:

```text
http://localhost:3000/webhook
```

## Test With Ngrok

```bash
ngrok http 3000
```

Give VideoSDK this URL:

```text
https://<your-ngrok-domain>/webhook
```

## VideoSDK Payload Handling

Ignored payloads:

- `body.webhookType === "call-started"`
- `body.webhookType === "call-hangup"`

Processed payload:

- `body["call-summary"]` exists

To update an existing lead, pass the Refrens API lead id in VideoSDK metadata/customer data:

```json
{
  "refrensLeadId": "6a453176001e6e0012f731be"
}
```

The backend also accepts a valid 24-character ObjectId in `customer-data.crm_lead_id`, but `refrensLeadId` is the preferred name because it clearly refers to the Refrens API `leadId`.

All current agent flows are patch-only. If no existing lead id is supplied, the backend stores the webhook and marks it skipped instead of creating a fallback lead.

The legacy create path can still generate a stable `externalId` if a future non-patch-only agent flow enables creation:

```text
externalId = videosdk-{callId}
```

That makes webhook retries idempotent at the Refrens lead-create API level.

## Agent Orchestration

Summary webhook parsing is routed through `src/agents`.

- GST agent: detected by `GST_AGENT_ID`.
- Ad hoc agent: detected by `ADHOC_AGENT_ID`.
- Ad hoc campaign parser currently supports `Lost_Rejected_Recovery`.

To add another dynamic campaign, add a parser in `src/agents/adhoc.js` and route by `metadata.campaign` / `summary.campaign`. To add another agent, add a new module under `src/agents` and register it in `src/agents/index.js`.

## GST Agent Flow

GST summary webhooks are detected when `room-data.agentId` matches `GST_AGENT_ID`, or when the summary contains GST-specific fields such as `call_status`, `current_invoicing_platform`, `requirement_type`, or `lead_priority`.

Ad hoc and GST calls are patch-only:

- If `refrensLeadId` exists and the Refrens lead is found, the backend patches the existing lead.
- If `refrensLeadId` is missing, the event is stored and skipped.
- If `refrensLeadId` is provided but Refrens returns not found, the event is stored and skipped.
- The backend does not create fallback leads for current agent flows.

GST patch behavior:

- Always appends the VideoSDK summary as internal notes.
- Always adds `Voice AI attempt` for every summary webhook that patches or creates a lead.
- Adds `Identity Confirmed` when `is_right_business` is `yes`.
- Does not check GST registration status from webhook fields.
- Does not add requirement tags for `invoicing_and_billing` or `complete_accounting` for now; those fields remain visible in internal notes.
- Adds `AI Demo Requested` when `demo_requested` is `yes`.
- Adds `Sales Person callback` when `is_need_callback` is `yes`.

GST stage movement:

- `Identity Confirmed` -> `1.e AI Contact - Identity Confirmed`
- `Sales Person Callback` -> `1.g AI Contact - Sales Person Callback`
- `Identity Confirmed + Sales Person Callback` -> `1.g AI Contact - Sales Person Callback`
- `Sales Person Callback + Identity Confirmed` -> `1.g AI Contact - Sales Person Callback`
- No identity/callback signal -> no pipeline or stage field is sent, so the lead stays in its existing LMS stage.

GST agent id and default GST caller number are configured through env:

```env
GST_AGENT_ID=ag_n8irvh
GST_SIP_CALL_FROM=+918035017510
GST_ROUTING_RULE_ID=rr_fogwqz
```

Tag names and stage names are kept in code constants so the CRM behavior stays versioned with the backend.

## GST Metabase First-Call Intake

GST first-call batches can be started from a saved Metabase question instead of uploading CSVs to the VideoSDK dashboard.

Current source:

```text
https://metabase-proded4fa3ab.azurewebsites.net/question/4645-leads-5-docs-gst-unassigned
```

The backend calls:

```text
POST {METABASE_URL}/api/card/{METABASE_GST_UNASSIGNED_QUESTION_ID}/query/json
```

Start a run:

```bash
curl -X POST https://videosdk-webhook-backend.onrender.com/jobs/metabase/gst-unassigned/run \
  -H "Content-Type: application/json" \
  -H "x-jobs-api-token: <JOBS_API_TOKEN>" \
  -d "{}"
```

Optional test limit:

```bash
curl -X POST https://videosdk-webhook-backend.onrender.com/jobs/metabase/gst-unassigned/run \
  -H "Content-Type: application/json" \
  -H "x-jobs-api-token: <JOBS_API_TOKEN>" \
  -d "{\"limit\": 3}"
```

Rows are normalized into:

```text
leadId, clientName, companyName, phone, email, status, stage, tags
```

Before the first call is queued, the backend checks tags from the Metabase row.

Blocking tags:

```text
ONQWVW1-utEzlg7E4tT3F  Sales Person Callback
lhZNBczeoRecfbNQvTcHa  GST Confirmed
sM1iZbCixqm7Ldibszs2f  Identity Confirmed
```

`a4Anq_x2Vmere1G-AqRXB` / `Voice AI attempt` is not a blocking tag by itself.

The backend keeps only one active outbound job per `sourceKey + leadId`. Active jobs block duplicate first-call dispatches while they are still controlling execution:

```text
scheduled
dispatching
dispatched
webhook_started
```

Terminal jobs are soft-closed with `active=false`, `terminalStatus`, `closeReason`, and `closedAt`, so they remain available for audit without blocking a future valid run:

```text
summary_received
webhook_timeout
dispatch_failed
pre_dispatch_check_failed
skipped
skipped_before_dispatch
```

Before dispatching the actual VideoSDK call, the outbound worker also performs a live Refrens `GET /leads/{leadId}` check. If the current CRM lead has any blocking tag id, the job is marked `skipped_before_dispatch` and no call is made. This protects against stale Metabase results.

Eligible leads are stored in `outbound_call_jobs` and dispatched by the outbound call worker:

- one job is dispatched per worker tick
- default tick is 2 seconds, so the backend does not trigger two first calls in the same second
- calls are still guarded by the 9 AM to 9 PM IST call window
- the VideoSDK metadata includes `outboundJobId`, `refrensLeadId`, `sourceKey`, and `metabaseQuestionId`
- if no webhook is received within 6 minutes, the job is requeued once by default

Run history is stored in:

```text
metabase_runs
```

First-call dispatch jobs are stored in:

```text
outbound_call_jobs
```

Useful Mongo filters:

```js
{ sourceKey: "gst_unassigned_leads" }
{ refrensLeadId: "lead_id_here" }
{ active: true }
{ status: "skipped" }
{ status: "webhook_timeout" }
{ status: "pre_dispatch_check_failed" }
{ status: "skipped_before_dispatch" }
{ outboundJobId: "job_id_here" }
```

## GST Retry Flow

GST retries are handled by this backend, not by the VideoSDK dashboard batch.

Retry rules:

- Total attempts: 3, including the original dashboard call.
- Standard retry flow: attempt 2 after 2 minutes, attempt 3 after 1 hour.
- Callback-requested retry flow: attempt 2 after 2 hours, attempt 3 after 2 hours.
- Calls are only dispatched between 9 AM and 9 PM IST.
- If a retry falls outside the call window, it remains queued and is scheduled for the next 9 AM IST call window.
- Standard retryable `call_status` values are `call_not_picked`, `voicemail`, and empty `failed`.
- `busy/failed + is_right_business=yes + is_need_callback=yes` uses the callback-requested flow.
- If a callback-requested retry is not picked, the next retry stays in callback-requested flow.
- `failed` with no meaningful summary fields follows the standard retry flow.
- `failed` with meaningful populated fields stops AI retries and tags/stages from the populated fields.
- `busy` with meaningful populated fields stops AI retries unless it qualifies for callback-requested flow.
- No retry is scheduled for `successful`, `on_hold`, missing phone number, missing `refrensLeadId`, missing webhook URL, or demo requested.

Retry jobs are stored in MongoDB:

```text
Database: videosdk_crm
Collection: call_retry_jobs
```

To see when the next retry call is scheduled for a lead, search by `refrensLeadId` in `call_retry_jobs` and check:

```text
status
retryAttempt
retryFlow
requestedScheduledAtIst
scheduledAtIst
businessHoursAdjusted
```

Retry jobs are deduped per lead and retry attempt. If a later webhook shows the lead should stop AI calling, such as callback needed, demo requested, or max attempts reached, pending scheduled retry jobs for that `refrensLeadId` are marked:

```text
status: cancelled
```

The original webhook record in `call_events` also stores the retry decision under:

```text
retry.scheduledAt
retry.scheduledAtIst
retry.retryJobId
retry.businessHoursAdjusted
retry.cancelledJobs
```

The retry worker runs inside the same Node service and scans due jobs every minute. It dispatches calls through:

```text
POST https://api.videosdk.live/v2/sip/call
```

Required retry env:

```env
VIDEOSDK_AUTH_TOKEN=
VIDEOSDK_WEBHOOK_URL=https://videosdk-webhook-backend.onrender.com/webhook
CALL_WINDOW_START_HOUR_IST=9
CALL_WINDOW_END_HOUR_IST=21
```

The retry dispatch payload is rebuilt from the original summary webhook customer data and includes:

- `sipCallFrom`
- `sipCallTo`
- `routingRuleId`
- `metadata.refrensLeadId`
- `metadata.originalCallId`
- `metadata.retryAttempt`
- `metadata.retryFlow`
- `metadata.name`
- `metadata.business_name`
- `metadata.age_of_business`
- `metadata.webhook_url`

Tags are sent with Refrens `tagsAdd`, which expects existing tag names. Refrens resolves the tag names internally; tag ids are not sent by this backend.

## Refrens Lead Create And Patch

The CRM module posts to:

```text
POST {REFRENS_API_BASE_URL}/api/v1/businesses/{REFRENS_BUSINESS_SLUG}/leads
```

With the current production defaults, that resolves to:

```text
POST https://api.refrens.com/api/v1/businesses/crm-lead-create/leads
```

When `refrensLeadId` is supplied, the CRM module first checks:

```text
GET {REFRENS_API_BASE_URL}/api/v1/businesses/{REFRENS_BUSINESS_SLUG}/leads/{leadId}
```

If found, it patches:

```text
PATCH {REFRENS_API_BASE_URL}/api/v1/businesses/{REFRENS_BUSINESS_SLUG}/leads/{leadId}
```

PATCH appends VideoSDK summary details as internal notes using `addInternalNotes` with a stable `clientRequestId`.

Ad hoc PATCH moves the lead to `REFRENS_DEFAULT_STAGE` only when the summary has a positive ad hoc signal such as `Interested`, `Callback Requested`, `Need Time`, `offer_interest=Interested`, or `sales_callback_required=true`. Without a positive signal, no pipeline or stage field is sent, so the lead stays in its existing LMS stage.

PATCH does not update `details`; call summaries are kept as internal notes on existing leads. New lead creation still writes summary content into `details` because create does not support internal notes.

The payload contains:

- `externalId`
- `customer.name`
- `customer.phone`
- `contact.name`
- `contact.phone`
- `subject`
- `details`
- `pipeline`
- `stage`
- `leadSource`
- `tags`

Dynamic call fields are written into `details` instead of `tags` or `customFields` because the tested Refrens API rejects unknown tags and may reject custom fields if they are not enabled for the business.

## MongoDB Storage

MongoDB stores webhook and lead-processing history in:

```text
Database: videosdk_crm
Collection: call_events
```

Each document stores:

- `callId`
- `webhookType`
- `rawPayload`
- `parsed`
- `isPositiveCall`
- `processing.status`
- `processing.attempts`
- `processing.lastError`
- `refrens.attempted`
- `refrens.success`
- `refrens.action`
- `refrens.externalId`
- `refrens.leadId`
- `refrens.statusCode`
- `refrens.requestPayload`
- `refrens.responsePayload`
- timestamps

The backend creates these indexes automatically:

```text
dedupeKey unique index
callId + webhookType index
roomId + webhookType index
refrensLeadId + receivedAt index
outboundJobId + webhookType index
processing.status + receivedAt index
```

`dedupeKey` uses:

```text
{webhookType}:{callId}
```

This keeps webhook retries from creating duplicate database records for the same call event.

## Deployment Notes

### Railway

1. Create a new project from this folder/repo.
2. Add environment variables from `.env.example`.
3. Set start command to `npm start`.
4. Use the public Railway domain as `https://<domain>/webhook`.

### Render

1. Create a new Web Service.
2. Build command: `npm install`.
3. Start command: `npm start`.
4. Add environment variables in Render dashboard.
5. Use `https://<render-domain>/webhook`.

### DigitalOcean App Platform

1. Create a Node.js app.
2. Set build command to `npm install`.
3. Set run command to `npm start`.
4. Add environment variables.
5. Use the generated app URL plus `/webhook`.

## Error Handling

- The webhook endpoint always responds `200`.
- Refrens API calls are wrapped in `try/catch`.
- Incoming webhook payloads and CRM API results are logged with timestamp and `callId`.
- Logs are written to stdout and `logs/app.log`.
