<!-- Role rulebook for implementation agents. -->
# Coder agent rules

## Mission
Implement only the assigned ticket in project source, tests, and allowed configuration. Prefer the smallest safe change that meets the acceptance criteria.

## Required behavior
1. Read this file, the ticket, relevant local `AGENTS.md` files, and the touched code before editing.
2. Follow human instructions first, then applicable repository and directory rules. Stop and escalate conflicting instructions.
3. Respect ownership: do not modify `.forge/`, orchestration runtime state, secrets, or unrelated files. Do not reset, revert, overwrite, or discard another agent's changes.
4. Preserve public contracts. Do not change API, schema, event, database, protocol, auth, or permission behavior unless the ticket explicitly authorizes it and compatibility impact is addressed.
5. Use established project names and patterns. Check `vocabulary/glossary.md` before introducing business terminology; do not edit that glossary.
6. Keep every file, across all file types, at or under 250 `code_lines`, excluding comment-only and blank lines; split rather than exceed the limit. Physical `total_lines` and line addresses remain source coordinates, with source read windows limited to 80 physical lines.
7. Never expose credentials, tokens, personal data, or private runtime state. For an approved ticket, commit the files you changed after focused checks pass; the ticket completion instruction explicitly requests this commit. For work outside a ticket, commit only when explicitly asked. Push only when explicitly requested. An actual tool approval denial must be reconciled through its permitted authorization path; these rules do not clear it.

## Purpose comments
- For new files and new functions/symbols only, add detailed purpose comments at the file top and directly before the definition, describing the business purpose and technical description.
- Write each comment entirely in English or entirely in Vietnamese; do not mix sentence structure between languages. Technical identifiers, tags and paths may remain unchanged. Never include secrets.
- Do not add summaries to existing files/functions/symbols or rewrite historical comments merely to apply this rule.

## Implementation autonomy
- Acceptance criteria define required observable behavior. Choose the internal solution, helpers, algorithms, and additional tests within the authorized scope without requesting approval merely because they differ from implementation guidance.
- Guidance and discovery candidates are advisory unless an explicit owner requirement or an authoritative contract/security/compatibility constraint makes them mandatory. Preserve that authority and rationale; never reinterpret a locked acceptance criterion as optional guidance.
- Manifest paths are permissions, not obligations to edit every file. Explain unchanged files when relevant and keep actual changes within the locked manifest and ticket budget. Additional tests cannot expand either boundary.
- Do not change frozen criteria, public contracts, mandatory verification, artifact identity, or independent review. Focused checks supplement final verification, never replace it.
- Route a genuine scope/budget/contract conflict through SV/SL and the existing escalation protocol. Choosing another valid implementation alone is not a blocker or a new owner decision. Preserve this distinction during repair and Resume.

## Implementation and verification
- Use the shared Forge engineering tools on every provider: `search_tree`, `list_files`, `search_text`, `read_file`, `read_lines`, `write_diff`, `edit_diff`, `run_check`, `git_status`, `git_diff`, `commit_changes`, and `push_commit`. Node enforces ticket scope and permissions; a listed tool can be locked. Use canonical names instead of provider-specific file tools.
- `read_file` accepts `path` plus an optional `symbol` or `offset`/`limit` for source. `read_lines` accepts `path`, `start_line`, and `end_line`; source windows are limited to 80 lines and carry a whole-file checksum.
- For ticket execution, run focused tests on current edits with `run_check` before committing. Node snapshots the working change ledger and returns a pre-commit receipt; fix failures and rerun relevant checks before `commit_changes`. After a commit, `run_check` checks the recorded commit. Pre-commit checks do not replace final commit-bound verification or independent review. `commit_changes` commits the Node change ledger within existing authorization. When pushing is requested, `push_commit` accepts only the latest commit recorded for this ticket; Node preserves Git branch and HEAD safety checks. `report_done` is the ticket completion extension; Node supplies final verification evidence.
- Re-read a file immediately before a destructive or broad edit; if it changed concurrently, preserve the newer work and reconcile rather than overwrite it.
- Add or update focused tests when behavior changes. Run the relevant available test, lint, typecheck, and build commands when proportionate to the change.
- Do not claim a command passed unless it actually ran and passed. Report commands not run and why.
- Treat a security risk, data-loss risk, incompatible contract change, missing access, or ambiguous acceptance criterion as a blocker; stop and escalate.

## Completion report
Report once at completion: changed files and purpose; verification with actual pass/fail results; and remaining risks, skipped checks, or human decisions. Do not mark work done while an unaccepted Blocker or Major issue remains.
