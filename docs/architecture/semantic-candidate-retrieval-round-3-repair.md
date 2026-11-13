<!-- Records the task-text candidate repair, the actual focused-check response, and platform limitations so the owner and independent Reviewer can resume acceptance without mistaking metadata for execution provenance. -->
# Round 3 saved findings: repair and evidence

Recipient: project owner, Architecture Manager and independent Reviewer.

Status: finding 1 repaired in the working tree; findings 2 and 3 remain open.
Inspected HEAD: `7e2a8ed8d4942e8efa5671f6d42b1e6059848500`.
No new revision was committed or pushed.

## Finding 1: absent task paths displace pinned candidates

The snapshot selector supplies an exact allowlist from its authorized, successfully read corpus after spreading caller arguments. The shared lexical scorer enforces this allowlist when adding shortlist entries and seeds, before ranking, graph expansion or final limiting. This covers paths parsed from title, objective and acceptance text as well as prior/dependency hints. Ordinary selection without an allowlist retains its existing behavior.

The new regression exercises all four snapshot methods with title, objective, both acceptance-criteria aliases, guardrails and query text naming `schemas/ghost.json`. Each request uses limit 1, a single pinned file exporting `committed`, absent prior/dependency hints, and a caller-supplied allowlist naming the absent file. The pinned file must remain selected with its committed symbol and revision. Positive cases verify that a task naming the pinned file still receives explicit-path scoring. There are 24 absent-path cases and four positive cases within one test.

| Changed file | Current SHA-256 |
| --- | --- |
| `backend/src/modules/index/relevant-tree-scoring.js` | `c821befb398f04fed763d3b55a0bfe8e3b79e77ba0231b4b3cb39e702c7b6593` |
| `backend/src/modules/supervisor/review/reviewer-snapshot-candidate-selector.js` | `ac517de100fc1bfe43e52ee8222cefb818b654c9ae609a81f75bf611c70220f4` |
| `backend/tests/unit/reviewer-snapshot-task-paths.test.js` | `df4ff7ce85135bfa7ad9dfbd6bd9f8db681fd4ae9e0178779fb4fddcd624afc4` |

These are Forge mutation checksums, not an execution manifest.

## Focused check response

One Forge `run_check` call returned:

- Run: `VERIFY-RUN-3e488dad-3241-4341-809b-658c10f061e7`.
- Evaluated at: `2026-11-11T01:02:34.376Z`.
- Status: `passed`; exit code: `0`; `ready_for_review: true`.
- Commit label: `7e2a8ed8d4942e8efa5671f6d42b1e6059848500`.
- Base label: `0d39fd3b1a7e7c2781bb079e59edcd60cfea743c`.
- Build, lint and typecheck: `not_applicable` in the response. No separate result is claimed.

Exact command:

```text
node --test backend/tests/unit/reviewer-snapshot-task-paths.test.js backend/tests/unit/reviewer-snapshot-candidate-selector.test.js backend/tests/unit/reviewer-snapshot-discovery.test.js backend/tests/unit/relevant-tree.test.js backend/tests/unit/candidate-runtime-access.test.js backend/tests/tools/select-code-graph-candidates.test.js backend/tests/tools/candidate-source-receipts.test.js backend/tests/tools/candidate-source-authority.test.js
```

The response provides no test-count output, loaded-source manifest, toolchain checksums or isolated checkout identity. The commit label predates this repair. It therefore cannot establish execution of the repair at that revision.

## Finding 2: execution provenance remains open

Direct inspection of `owner-engineer-tools.js:runCheck` confirms that it forwards a revision label to the test service and saves a compact receipt in conversation state. It does not produce an isolated checkout or a transitive execution manifest.

A scoped listing of `.forge/runtime/nf/verification` returned only `VERIFY-RUN-cb4d1d4a-9d87-4a9d-9c82-012e56a76ba2.json`; neither the prior reported run nor this new run had an accessible standalone artifact there.

A governed `run_command` probe for `node --version`, with `timeout_ms: 10000`, returned no result while awaited. The waiting orchestration was terminated; command completion, cancellation and toolchain version are unknown. No execution provenance is inferred from that probe.

The supplied commit operation accepts only a message and commits the conversation's recorded paths. Its inherited ledger includes runtime files beyond this repair. A safe repair-only commit is unavailable through that interface; unrelated staged and unstaged changes were preserved.

To close this finding, the platform must provide a repair-only commit scope and an executing runner that saves accessible source/dependency/toolchain checksums and binds them to the submitted revision. Verification must then run against that revision.

## Finding 3: fresh AM → SE → RV demonstration remains open

Fresh SE candidate retrieval succeeded during this repair and returned verified receipts with durable evidence. That establishes this session's SE access only.

Delegation `CORR-HANDOFF-PLAN-PROJECT-NODEFORGE-998a13a3-3a73-41eb-9343-1a7f11d2bdee-SE-R3-8a3f1144-b922-444a-82a5-2ea77f39cc60:delegation:1` explored verification and role orchestration. Both workers were issued `role: system_engineer`; they cannot stand in for AM or RV. Historical architecture-manager evidence was reused for discovery, but is not a fresh demonstration.

The callable Forge catalog exposes no role-session launch or AM/RV handoff invocation tool. No role identities, approvals or platform receipts were authored to simulate one.

To close this finding, an actual AM session must discover the final source, SE must reuse that receipt, and an actual RV session must read the shared evidence and validate matching path, current checksum, symbol map and source revision. Preserve the three platform-issued session/tool results for independent acceptance.
