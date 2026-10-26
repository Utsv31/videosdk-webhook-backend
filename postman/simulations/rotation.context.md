# Rotation Simulation

Local VideoSDK stand-in derived from this repository's existing dispatch fixture
and the response shape already consumed by `src/services/videosdk.js`.

## Purpose
Exercise the real rotation worker and webhook route without calling test
recipients or changing production CRM/cohort records.

## Execution
1. `postman simulation run postman/simulations/rotation.sim.yaml --port 4916 --output ndjson`
2. Supply `MONGODB_URI` privately and run `node scripts/verifyRotationSimulation.js`.
   The script selects its own uniquely named temporary database.
3. Check the simulation request events, then stop the simulation with Ctrl+C.

## Assumptions
- Atlas on this account limits database names to 38 bytes; use the shorter
  `rotation_test_` prefix. Cleanup must close the Mongo client even if collection
  cleanup fails. (observed 2026-10-26)
- The fixture models SIP dispatch acceptance, not actual telephony or routing-rule
  ownership. Real SIP authorization and metadata echo remain live-only checks.
  The owner's published mock was not searched; the existing local fixture was
  reused as the contract source. (reasoned 2026-10-26)
- Run during 09:00-21:00 IST: the production window guard stays enabled. The
  script adjusts only its isolated database slots to avoid waiting all day.
  (observed 2026-10-26)

## Observations
<!-- begin:observations -->
2026-10-26: VideoSDK served acceptance, 400, 500 and missing-call-ID requests.
Mongo persisted summaries and terminal failures; no Refrens or cohort-retry
traffic was required. The isolated test collections were cleared afterwards.
<!-- end:observations -->

## What Didn't Work
- 2026-10-26: Atlas rejected the original long test database name with "Max
  database name length is 38 bytes" before dispatch. Shortening the name and
  closing the client in cleanup resolved it in the successful verification run.
