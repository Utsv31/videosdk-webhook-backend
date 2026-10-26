# Four-number rotational calling

This is separate from Metabase cohorts. Defaults are **five calls per recipient per
day (20 total)**, four unique recipients, two SIP callers, and 09:00-21:00 IST.
Calls are evenly spaced across that window, never less than five minutes apart.
The caller alternates across rounds so each recipient is called through both SIP
routes. The default 20-call schedule is every 36 minutes; a recipient is called
every 144 minutes. The final slot starts at 20:24 IST.

## Configuration And Activation

The checked-in `config/rotationalCalls.json` is disabled and contains no phone
numbers. Put the actual configuration in a Render secret file named
`rotational_calls.json`. Locally the same filename is read from the repository
root and is gitignored. Existing VideoSDK/Mongo/JOBS credentials are reused.
No new credentials are necessary. An optional `ROTATIONAL_CALLS_CONFIG_FILE`
can point at a different JSON file; do not place credentials in its metadata.

The local file has the supplied four recipients and the two confirmed SIP routes.
Preview before activation. Use authorized SIP routes
only. Set both `enabled` and `consentConfirmed` to true only for recipients you
control or who have agreed to these repeated calls. `metadata` can carry the
agent's existing prompt/campaign fields; reserved rotation and webhook fields
are always controlled by the backend. The workflow intentionally does not patch
CRM leads, set CRM tags/stages, or enter normal GST/ad-hoc retry flows.

```json
{
  "enabled": false,
  "consentConfirmed": false,
  "dailyLimitMode": "per_recipient",
  "dailyCalls": 5,
  "startHourIst": 9,
  "endHourIst": 21,
  "minimumGapMinutes": 5,
  "recipients": [
    {"name":"Test 1","phone":"+919000000001"},
    {"name":"Test 2","phone":"+919000000002"},
    {"name":"Test 3","phone":"+919000000003"},
    {"name":"Test 4","phone":"+919000000004"}
  ],
  "callerRoutes": [
    {"sipCallFrom":"+919000000005","routingRuleId":"rr_first"},
    {"sipCallFrom":"+919000000006","routingRuleId":"rr_second"}
  ],
  "metadata": {}
}
```

## API Contract

All endpoints below require `x-jobs-api-token` or `Authorization: Bearer ...`
using the existing JOBS token. Missing server-side JOBS configuration returns
503; an absent/wrong caller token returns 401. Invalid input/configuration returns
400. Database/unexpected errors return the existing generic 500 error response.
All successful responses include `success: true`.

| Method / Path | Input | Behavior |
| --- | --- | --- |
| GET `/jobs/rotation/preview` | Optional `?date=YYYY-MM-DD` (IST) | Returns `dryRun: true` and the plan/slots. No database writes or calls. |
| POST `/jobs/rotation/run` | Optional JSON `{"dryRun":true,"date":"YYYY-MM-DD"}` | Defaults to preview. Explicit `dryRun:false` queues today's immutable plan; no immediate dispatch. Live configuration and consent are required. |
| GET `/jobs/rotation/status` | Optional IST date | Returns `plan`, slot `jobs`, and status `counts`; includes schedule, recipient, caller, provider response and received webhooks. |
| POST `/jobs/rotation/stop` | Optional IST date | Stops that day and cancels unclaimed slots. Returns `cancelled`; it cannot recall an in-flight/provider-submitted call. Re-running the same day does not undo this stop. |

Omitted dates use today's date in Asia/Kolkata. A repeated live run never adds
extra slots. Tomorrow has a different plan, subject to enabled/consent settings.
Changing recipients, routes, limits or metadata after today's plan is created
stops further dispatch until the configuration matches again; tomorrow uses the
new configuration. Disable the configuration to stop all subsequent days, or
use `/stop` to stop only one day. Skipped/failed/unknown slots consume their daily
allocation: five is a maximum number of attempts, not a promise of five connects.

```bash
curl 'https://videosdk-webhook-backend.onrender.com/jobs/rotation/preview' \
  -H 'x-jobs-api-token: <JOBS_API_TOKEN>'

curl -X POST 'https://videosdk-webhook-backend.onrender.com/jobs/rotation/run' \
  -H 'x-jobs-api-token: <JOBS_API_TOKEN>' \
  -H 'Content-Type: application/json' -d '{"dryRun":false}'

curl 'https://videosdk-webhook-backend.onrender.com/jobs/rotation/status' \
  -H 'x-jobs-api-token: <JOBS_API_TOKEN>'

curl -X POST 'https://videosdk-webhook-backend.onrender.com/jobs/rotation/stop' \
  -H 'x-jobs-api-token: <JOBS_API_TOKEN>' \
  -H 'Content-Type: application/json' -d '{}'
```

## Scheduling, Failures And Logs

The Node worker checks every 30 seconds while Render is awake; the existing
`POST /jobs/workers/tick` also runs it. Extend the external wake-up cron to cover
09:00-21:00 IST (and allow time after the final call for summary delivery).
The previous 09:00-15:00 cron does not cover an all-day rotation. Sleeping Render
cannot run a timer. A missed slot expires at the next slot boundary, rather
than creating an evening catch-up burst. Old days are never redialled.
The shared `CALL_WINDOW_START_HOUR_IST` / `CALL_WINDOW_END_HOUR_IST` guard also
applies; it must allow the full rotation window.

Mongo collections:
- `rotational_call_days`: immutable daily schedule and stop state.
- `rotational_call_jobs`: each allocated call, schedule/expiry, payload, provider
  response/status, actual call ID, webhook flags, summary and errors.
- `rotational_call_locks`: atomic worker lease and minimum spacing across replicas.
- `call_events`: existing raw webhook audit with top-level `rotationJobId`.

Slots move from `scheduled` to `dispatching`, then `dispatched` and `completed`
when a summary arrives. Late starts/hangups cannot reopen a completed slot.
Provider 4xx responses become `dispatch_failed`; 5xx/network uncertainty or a
200 without a call ID becomes `dispatch_unknown`. Interrupted claims also
become `dispatch_unknown`; these are not automatically resent. No summary within
six minutes becomes `summary_timeout`, whether or not start/hangup arrived.
Late valid summaries can still complete the slot. Missing webhooks do not add
extra calls beyond the five daily allocations.

## Verification

`npm test` includes plan, auth, dry-run and CRM-isolation checks. The reusable
Postman simulation in `postman/simulations/rotation.sim.yaml` runs the real
VideoSDK HTTP client against a local fixture. See its context document and
`scripts/verifyRotationSimulation.js` for isolated Mongo verification. Neither
test dispatches calls to real recipient numbers.
