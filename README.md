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
VIDEOSDK_AUTH_TOKEN=
VIDEOSDK_API_BASE_URL=https://api.videosdk.live
VIDEOSDK_WEBHOOK_URL=https://videosdk-webhook-backend.onrender.com/webhook
RETRY_WORKER_ENABLED=true
RETRY_WORKER_INTERVAL_MS=60000
CALL_WINDOW_START_HOUR_IST=9
CALL_WINDOW_END_HOUR_IST=21
MONGODB_URI=mongodb+srv://<db_username>:<db_password>@cluster0.qdrculk.mongodb.net/videosdk_crm?retryWrites=true&w=majority&appName=Cluster0
MONGODB_DB_NAME=videosdk_crm
MONGODB_EVENTS_COLLECTION=call_events
MONGODB_RETRY_JOBS_COLLECTION=call_retry_jobs
```

Optional:

```env
VIDEOSDK_WEBHOOK_SECRET=
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

## GST Agent Flow

GST summary webhooks are detected when `room-data.agentId` matches `GST_AGENT_ID`, or when the summary contains GST-specific fields such as `call_status`, `gst_status`, or `lead_priority`.

Ad hoc and GST calls are patch-only:

- If `refrensLeadId` exists and the Refrens lead is found, the backend patches the existing lead.
- If `refrensLeadId` is missing, the event is stored and skipped.
- If `refrensLeadId` is provided but Refrens returns not found, the event is stored and skipped.
- The backend does not create fallback leads for current agent flows.

GST patch behavior:

- Always appends the VideoSDK summary as internal notes.
- Adds `Identity Confirmed` when `is_right_business` is `yes`.
- Adds `GST Confirmed` when GST registration is confirmed.
- Does not add requirement tags for `invoicing_and_billing` or `complete_accounting` for now; those fields remain visible in internal notes.
- Adds `AI Demo Requested` when `demo_requested` is `yes`.
- Adds `Sales Person callback` when `call_status` is `busy` and callback is needed.
- Moves to `1.g AI Contact - Sales Person Callback` for busy + callback-needed calls.
- Otherwise moves to `1.e AI Contact - Identity Confirmed` when identity or GST registration is confirmed.

GST agent id and default GST caller number are configured through env:

```env
GST_AGENT_ID=ag_n8irvh
GST_SIP_CALL_FROM=+918035017510
GST_ROUTING_RULE_ID=rr_fogwqz
```

Tag names and stage names are kept in code constants so the CRM behavior stays versioned with the backend.

## GST Retry Flow

GST retries are handled by this backend, not by the VideoSDK dashboard batch.

Retry rules:

- Total attempts: 3, including the original dashboard call.
- Standard retry flow: attempt 2 after 2 minutes, attempt 3 after 1 hour.
- Busy engaged retry flow: attempt 2 after 30 minutes, attempt 3 after 1 hour.
- Calls are only dispatched between 9 AM and 9 PM IST.
- If a retry falls outside the call window, it remains queued and is scheduled for the next 9 AM IST call window.
- Standard retryable `call_status` values are `call_not_picked`, `voicemail`, and `failed`.
- Busy calls use the busy engaged flow only when `is_right_business=yes` and `is_need_callback=no`.
- `busy + is_need_callback=yes` does not retry; the lead gets the `Sales Person callback` tag and sales callback stage.
- `busy/failed + GST registered` does not retry; the lead gets the `GST Confirmed` tag and normal confirmed stage.
- `busy/failed + is_right_business=yes` without explicit `is_need_callback=no` does not retry; the lead gets the `Identity Confirmed` tag and normal confirmed stage.
- `failed + is_right_business=yes + is_need_callback=no` follows the standard retry flow.
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

Retry jobs are deduped per lead and retry attempt. If a later webhook shows the lead should stop AI calling, such as callback needed, GST confirmed, demo requested, or max attempts reached, pending scheduled retry jobs for that `refrensLeadId` are marked:

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
- `metadata.is_gst_registered`
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

For now, PATCH moves the lead to:

```text
Pipeline: Sales Pipeline
Stage: Contacted
```

and appends VideoSDK summary details as internal notes using `addInternalNotes` with a stable `clientRequestId`.

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
- `tags: []`

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
