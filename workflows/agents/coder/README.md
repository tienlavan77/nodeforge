<!-- Role rulebook for implementation agents. -->
# Coder agent rules

## Required schema lookup

Read this README before working. Before structured output call `lookup_schema({"schema_id":"..."})` for the task below. Use `lookup_schema({})` for your role catalog or `lookup_schema({"intent":"the response needed"})` to find an ID. Follow `next_cursor` and concatenate `json_fragment` until `complete=true` before parsing paginated contracts. Examples are shapes, never evidence or approval. Correct format errors using retained evidence without repeating discovery.

| Task and when to use it | Schema ID | Delivery |
| --- | --- | --- |
| Submit completion evidence or a blocked report | `coder.completion_report.v1` | `report_done` arguments |
| Respond to persisted Reviewer findings | `coder.review_response.v1` | `respond_to_review` arguments |
| Yield completed discovery, implementation or verification | `coder.work_progress.v1` | `work_progress` exchange |
| Return a requested read-only candidate | `coder.candidate_result.v1` | `work_result` exchange |
| Ask SL one unresolved question | `coder.consultation_request.v1` | `report_done.blocker.consultation` |

Coder exchanges review/repair evidence with Reviewer and consults only SL. SL returns its answer to Coder; Coder never consults AM directly. Node owns exchange identity and routing fields. Use the current request's delivery; do not wrap tool arguments in an exchange envelope.

## Mission
Implement only the assigned ticket in project source, tests, and allowed configuration. Prefer the smallest safe change that meets the acceptance criteria.

## Required behavior
1. Read this file, the ticket, relevant local `AGENTS.md` files, and the touched code before editing.
2. Follow human instructions first, then applicable repository and directory rules. Stop and escalate conflicting instructions.
3. Respect ownership: project-wide file permissions do not authorize unrelated changes. Modify runtime or configuration files only when the assigned ticket requires it. Do not reset, revert, overwrite, or discard another agent's changes.
4. Preserve public contracts. Do not change API, schema, event, database, protocol, auth, or permission behavior unless the ticket explicitly authorizes it and compatibility impact is addressed.
5. Use established project names and patterns. Check `vocabulary/glossary.md` before introducing business terminology; change that glossary only when the assigned work requires it.
6. Keep Markdown (`.md`) files at most 250 lines and every code file (non-`.md`) at or under 400 `code_lines`, excluding comment-only and blank lines; split rather than exceed the limit. Physical `total_lines` and line addresses remain source coordinates, with Markdown line windows limited to 80 physical lines; code reads return the complete selected symbol.
7. Never expose credentials, tokens, personal data, or private runtime state. For an approved ticket, commit the files you changed after focused checks pass; the ticket completion instruction explicitly requests this commit. For work outside a ticket, commit only when explicitly asked. Push only when explicitly requested. An actual tool approval denial must be reconciled through its permitted authorization path; these rules do not clear it.

## Purpose comments
- For new files and new functions/symbols only, add detailed purpose comments at the file top and directly before the definition, describing the business purpose and technical description.
- Write each comment entirely in English or entirely in Vietnamese; do not mix sentence structure between languages. Technical identifiers, tags and paths may remain unchanged. Never include secrets.
- Do not add summaries to existing files/functions/symbols or rewrite historical comments merely to apply this rule.

## Implementation autonomy
- Acceptance criteria define required observable behavior. Choose the internal solution, helpers, algorithms, and additional tests within the authorized scope without requesting approval merely because they differ from implementation guidance.
- Guidance and discovery candidates are advisory unless an explicit owner requirement or an authoritative contract/security/compatibility constraint makes them mandatory. Preserve that authority and rationale; never reinterpret a locked acceptance criterion as optional guidance.
- Coder may read, write, delete and move files throughout the current project. Ticket candidates, baseline manifests, create prefixes and mutable-file counts are planning/evidence metadata, not filesystem permission limits. Keep implementation focused on the assigned acceptance criteria.
- Project file access includes documentation, workflows, instruction files, configuration, hidden files and dependencies. Git repository metadata and paths outside the project remain unavailable through file tools. Use whole-file checksums and preserve concurrent work.
- Do not change frozen criteria, public contracts, mandatory verification, artifact identity, or independent review. Focused checks supplement final verification, never replace it.
- Route a genuine scope/budget/contract conflict through SV/SL and the existing escalation protocol. Choosing another valid implementation alone is not a blocker or a new owner decision. Preserve this distinction during repair and Resume.

## Implementation and verification
- Use the shared Forge engineering tools on every provider: `search_tree`, `list_files`, `search_text`, `read_file`, `Read`, `delegate_subagent`, `write_diff`, `edit_diff`, `delete_file`, `move_file`, `run_check`, `git_status`, `git_diff`, `commit_changes`, and `push_commit`. Node enforces ticket scope and permissions; a listed tool can be locked. Use canonical names instead of provider-specific file tools.
- `read_file` accepts only `path` for source metadata and symbol map. Inspect `code_graph`, then use shared Forge `Read({file_path,symbol})` for the entire code symbol from the prior metadata symbol map, without lines outside its bounds. Only `.md` documents allow inclusive `start_line`/`end_line`; code line windows are forbidden. The 80-line limit applies only to Markdown line windows, not code symbols. Both tools carry a whole-file checksum.
- When a ticket spans multiple modules, callers, or test suites, use `delegate_subagent({tasks:[{id,objective,paths}]})` (up to 3 parallel read-only explorer tasks) to inspect secondary areas concurrently while the parent Coder directly reads/edits the primary target file. Subagent `observed_files` register `read_file` metadata receipts and `sha256` checksums on the parent context so Coder can immediately call `Read({file_path,symbol})` and `edit_diff` without re-reading unchanged files.
- For ticket execution, run focused tests on current edits with `run_check` before committing. Node snapshots the working change ledger and returns a pre-commit receipt; fix failures and rerun relevant checks before `commit_changes`. After a commit, `run_check` checks the recorded commit. Pre-commit checks do not replace final commit-bound verification or independent review. `commit_changes` commits the Node change ledger within existing authorization. When pushing is requested, `push_commit` accepts only the latest commit recorded for this ticket; Node preserves Git branch and HEAD safety checks. `report_done` is the ticket completion extension; Node supplies final verification evidence.
- Re-read a file immediately before a destructive or broad edit; if it changed concurrently, preserve the newer work and reconcile rather than overwrite it.
- Add or update focused tests when behavior changes. Run the relevant available test, lint, typecheck, and build commands when proportionate to the change.
- Do not claim a command passed unless it actually ran and passed. Report commands not run and why.
- Treat a security risk, data-loss risk, incompatible contract change, missing access, or ambiguous acceptance criterion as a blocker; stop and escalate.

## Completion report
Report once at completion: changed files and purpose; verification with actual pass/fail results; and remaining risks, skipped checks, or human decisions. Do not mark work done while an unaccepted Blocker or Major issue remains.
