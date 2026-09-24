# NodeForge project instructions (Claude Code)

## Code summary comments

- When creating a new file, add a short summary comment at the top of the file.
- When creating a new function, add a short summary comment right before the function definition.
- The summary should describe the purpose of the file or function, not narrate each line of code.
- The summary should state the **business purpose** alongside the technical description when possible — e.g. "Retry a failed response generation" instead of just "Calls the retry API". This summary is used as embedding content for semantic search (`select_code_graph_candidates`), so the closer it reads to how a user or ticket would describe the feature, the more accurate retrieval will be.
- Do not add a summary to an existing file or function unless it is newly created.
- The summary must be written in the same language as the file's code and must not contain secrets.

## Vocabulary glossary

- Before naming a new file, function, module, or variable, check `vocabulary/glossary.md`.
- If the business concept in the ticket already has a mapping in the glossary (e.g. "Regenerate" -> `retry`/`regen`), use that standardized code term -- do not invent a different synonym.
- If the ticket has a `vocabulary_hints` field, prefer the terms listed there when naming.
- If you encounter a new business concept not yet in the glossary, pick a reasonable code term consistent with similar existing names in the codebase. Do not edit `vocabulary/glossary.md` yourself -- new mappings are proposed through a separate Node-triggered suggestion pipeline and reviewed by a human before being merged.
- Purpose: keep the semantic gap between how tickets are phrased and how code is named as small as possible, so semantic search can find the right file when a future ticket reuses the same business term.

## File size limits

- Every file must stay at or under 250 lines. If a change would push a file over this limit, split the file instead of adding to it.
- This threshold is set near the 90th percentile of the current codebase (measured n=207 files, 2026-09-22: p50=72 lines/1 export/5 functions, p75=123/2 exports/9 functions, p90=246/3/17, p95=309/6/25) — it caps outlier growth, not the typical file size. Re-measure and adjust if the codebase's overall size distribution shifts significantly.
- No exceptions once over the limit — split rather than justify staying over.
- This exists in part because oversized, many-symbol files distort retrieval scoring (many weak partial term matches accumulate into a misleadingly high relevance score for an otherwise unrelated file) — keeping files smaller is a defense against this, complementary to fixing the scoring itself.

## Focus and reporting

- Stay focused on the assigned ticket's scope — do not wander into unrelated files, refactors, or "while I'm here" changes.
- Work autonomously through to completion; do not pause mid-task to check in or ask for confirmation unless genuinely blocked (missing access, ambiguous/contradictory acceptance criteria, or a decision that changes ticket scope).
- Report once, at the end of the task: what was done, the result (pass/fail, numbers if applicable), and any open item that needs a human decision. Do not narrate intermediate steps as running commentary, and do not pad the report with process color unrelated to the outcome.

## Error logging

- Never swallow errors in `catch`: log via logger/console, rethrow, or reference the caught error; best-effort probes use `// eslint-disable-next-line no-silent-catch -- <reason>`.