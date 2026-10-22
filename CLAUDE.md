# NodeForge project instructions (Claude Code)

## Code summary comments

- For new files and new functions/symbols only, add detailed purpose comments at the top of the file and directly before the new definition.
- Describe the **business purpose** alongside the **technical description**, rather than narrating each line. Detailed multiline comments are allowed and help semantic search retrieve the intended behavior.
- Write each comment entirely in English or entirely in Vietnamese; do not mix sentence structure between languages. Technical identifiers, tags and paths may remain unchanged. Never include secrets.
- Do not add summaries to existing files/functions/symbols or rewrite historical comments merely to apply this rule.

## Vocabulary glossary

- Before naming a new file, function, module, or variable, check `vocabulary/glossary.md`.
- If the business concept in the ticket already has a mapping in the glossary (e.g. "Regenerate" -> `retry`/`regen`), use that standardized code term -- do not invent a different synonym.
- If the ticket has a `vocabulary_hints` field, prefer the terms listed there when naming.
- If you encounter a new business concept not yet in the glossary, pick a reasonable code term consistent with similar existing names in the codebase. Do not edit `vocabulary/glossary.md` yourself -- new mappings are proposed through a separate Node-triggered suggestion pipeline and reviewed by a human before being merged.
- Purpose: keep the semantic gap between how tickets are phrased and how code is named as small as possible, so semantic search can find the right file when a future ticket reuses the same business term.

## File size limits

- Every file, across all file types, must stay at or under 250 `code_lines`, excluding comment-only and blank lines. Split the file rather than exceed this limit.
- Physical `total_lines` and line addresses remain unchanged; they are source coordinates, not the code budget. Source read windows remain limited to 80 physical lines.
- Keeping substantive code small improves retrieval precision without penalizing detailed purpose comments.

## Focus and reporting

- Stay focused on the assigned ticket's scope — do not wander into unrelated files, refactors, or "while I'm here" changes.
- Work autonomously through to completion; do not pause mid-task to check in or ask for confirmation unless genuinely blocked (missing access, ambiguous/contradictory acceptance criteria, or a decision that changes ticket scope).
- Report once, at the end of the task: what was done, the result (pass/fail, numbers if applicable), and any open item that needs a human decision. Do not narrate intermediate steps as running commentary, and do not pad the report with process color unrelated to the outcome.

## Error logging

- Never swallow errors in `catch`: log via logger/console, rethrow, or reference the caught error; best-effort probes use `// eslint-disable-next-line no-silent-catch -- <reason>`.
