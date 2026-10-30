<!-- Documents behavior-based Coder autonomy, verified entrypoints, and safe rollout limitations. -->
# Coder implementation autonomy

## Contract

The owner requested direct engineering against
`workflows/plan-coder-autonomy-behavior-verification.md`. This change does not
approve a Sprint, dispatch tickets, change historical approvals, or declare
production acceptance.

Acceptance is based on observable behavior, authoritative constraints,
regression risk, and revision-bound evidence. Coder may choose a different
helper, algorithm, internal organization, or additional tests within the
approved scope, manifest, and file budget. Guidance and candidate paths do not
require edits or a new owner decision by themselves. Frozen criteria and
mandatory verification are not reinterpreted as guidance.

The four role rulebooks define responsibilities. The shared prompt reminders
in `src/shared/implementation-autonomy.js` carry those semantics to:

- Sprint SDK drafting and its priority-only repair, plus legacy Sprint streaming;
- ticket SDK drafting/regeneration and the CRUD streaming fallback;
- Codex and Claude Coder prompts, including direct and immutable-manifest modes;
- the base Coder prompt retained by Resume/review repair;
- independent Reviewer dispatch.

No schema, permissions, blocker recovery protocol, review gate policy, or
verification admission rule was relaxed.

## Gate audit

| Boundary | Finding and disposition |
| --- | --- |
| Governed report | `agent-report-tool.js` calls `validateGovernedScope` against the committed delta; unchanged manifest candidates are not edit obligations. Retained. |
| Legacy report | `assertReportScope` runs only without governed verification; it infers required implementation paths from ticket wording. Retained: this change does not establish a wrongly blocked production entrypoint. |
| Criterion evidence | `node-report-evidence.js` derives coverage from the approved verification map and passing command receipts. `assertCoderCoverage` rejects pending coverage. Retained. |
| Manifest | `ticket-execution-context.js` retains approved baseline path checks, versioned manifest identity, and frozen terminal context. Retained. |
| Review | Exact commit/artifact matching and author/reviewer separation remain mandatory. The 24-file bounded review evidence limit is a separate technical limit, not a four-file governance budget. Retained. |
| File budget | `schemas/governance/ticket.schema.json` requires an integer with minimum 1, no maximum. `assertSprintPlanGovernance` and outcome admission require positive budgets; legacy Markdown admission also preserves the explicit approved row budget. No runtime budget relaxation. |

Architecture's global four-file wording was reconciled with these active
consumers and the SL rulebook. Explicit budgets in existing approved artifacts
remain binding. Historical plans/reports were not rewritten. This audit is not
a claim that arbitrary file counts are executable through every downstream
technical limit.

## Verification witnesses

`tests/unit/implementation-autonomy.test.js` exercises both Coder prompt
builders, direct/immutable variants, checkpoint roundtrip and repair, Sprint
priority-only repair, ticket generation, and independent Reviewer dispatch.
These are prompt/state integration tests, not proof of live agent behavior.

`tests/integration/implementation-autonomy.test.js` creates disposable root-only
projects with real Git commits, Node-executed behavioral tests, durable
verification artifacts, the governed report tool, exact-evidence review worker,
and persisted review dispositions. A seeded reduction and an alternative loop
satisfy the same contract with distinct source/commit/artifact identities. An
unseeded reduction follows the suggested approach but fails empty-input
behavior and is stopped at verification. Stale review artifact identity is
rejected before provider dispatch. An unrelated candidate remains unchanged.

Declared doubles: Reviewer SDK verdict, agent profile resolution, and protocol
storage transport. There is no live Coder or Reviewer provider invocation.
This witness does not establish live agent autonomy or production acceptance.

One focused `run_check` covered both new suites and eight adjacent regression
files: `VERIFY-RUN-77bcc930-ae7d-4cb6-97a0-3c4ef72ff34b` returned **failed** with
one reported failure in `tests/unit/review-worker.test.js:54`. That pre-existing
test calls `runtime.reviewer.review`, but `ticket-workspace-runtime.js` returns
only `{ executors }`; neither file was changed here. No new-suite failure was
reported. The aggregate run is not green. Lint/build/typecheck were not run.

## Rollout and rollback: not completed

Do not assume hot reload or a process restart is safe for existing tickets.
Reviewer rules are snapshotted by automatic review, but that alone does not
bind the Coder rulebook, shared prompt reminders, runtime code, and every
repair/Resume entrypoint for an entire execution. Full binding across rollback
has not been established by this change.

Before cutover, inventory affected active executions, parked review jobs, and
stopped checkpoints still eligible for Resume. Either demonstrate preservation
of their original semantics, or keep cutover blocked until the existing
execution/disposition mechanism safely drains them. No project runtime state
or ticket approval was changed as part of this implementation.

Rollback must restore this change's code and rulebook revisions together using
a reviewed, path-scoped patch. Do not restore unrelated working-tree changes,
rewrite artifacts, or reuse approval for another revision. Apply the same
active/parked/stopped-execution check before rollback.

## Remaining acceptance evidence

- Resolve the existing adjacent regression failure before claiming a green gate.
- Run live-agent evaluations with provider/model, configuration, run count,
  pass/fail criteria, infrastructure-error classification, and retry rules fixed
  before execution. Preserve every run, transcript/report, contract revision,
  artifact reference, error, and rerun; do not cherry-pick a successful run.
- Execute owner Stop/Resume and rollback/cutover witnesses for affected runtime
  versions, including stopped checkpoints, before enabling rollout.
- Obtain independent review and any required release evidence. Do not treat the
  deterministic provider double as that review or as live-agent evaluation.
