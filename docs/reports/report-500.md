# Report: `run` API returns 500

## Summary
The dashboard `Run` action is failing because the Stage-1 pipeline contract is not fully aligned end-to-end. The current implementation has multiple moving parts that were changed in different directions (`full_content`, `full_file`, `structured_patch`), and the request/response schemas, prompt instructions, and Stage-1 handlers are not all synchronized.

## Likely failure points
- `stage1-task-request-builder.js` and `stage1-request-sender.js` were updated to new submission representations, but the OpenAPI/response schemas and runtime handlers have been changed multiple times and may still be out of sync.
- `stage1-ticket-runner.js` builds request payloads dynamically and relies on the Stage-1 schema contract being consistent.
- The `Run` API routes through `ticketRunner` in `backend/src/transport/http/server.js`, so any schema/contract mismatch in Stage-1 can surface as HTTP 500.

## Impact
- Clicking `Run` on the dashboard can fail before a ticket starts executing.
- This is a backend contract issue, not a dashboard rendering issue.

## Notes
- The repository currently shows evidence of multiple concurrent format changes (`full_content`, `full_file`, `structured_patch`).
- The safest next step is to pick one submission contract and make the builder, sender, schemas, normalizer, and handler all agree on it.
