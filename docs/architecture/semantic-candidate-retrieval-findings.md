# Semantic Candidate Retrieval — Open Findings for SE

**Status:** Implemented in the working tree, but not accepted. SE must resolve the findings below before requesting another independent RV review.

**Scope:** O1 evidence-grounded candidate retrieval and O2 role/provider accessibility. This document is a coding-finding handoff, not an approval and not a mutable-file manifest.

## 1. Revision and verification blocker — Major

The implementation has been reviewed in multiple mutable working-tree states. RV must review a clean, committed revision; working-tree evidence is supplementary only.

Required before RV re-review:

- Commit only the intended source, test, and architecture-document changes.
- Keep `.forge/runtime/**`, `ui/nextjs/.next/**`, SQLite sidecars, reports, evidence stores, and other generated runtime data out of the commit.
- Produce a verification artifact bound to the exact commit SHA and base SHA.
- Record the executed test scope, result, source revision, changed-path manifest, and per-file checksums.
- Do not claim production acceptance: the current verification framework does not yet prove a fully isolated dependency/toolchain manifest.

## 2. O1 — Candidate receipt and evidence synchronization

### Finding O1-A: Relevance receipt is not durably linked to provenance receipt — Major

`select_code_graph_candidates` currently routes verified candidates to durable evidence through `syncToolResultToEvidenceStore`, but the sync path must preserve both kinds of evidence:

- **Relevance receipt:** semantic score, lexical match, dependency relation, matched symbols, AC/intent matches, reasons, and confidence.
- **Provenance receipt:** path, current SHA-256, symbol map, graph metadata, freshness, scope, execution identity, and source revision.

**Required behavior:** `recordDirectEvidence` must not replace or silently omit the candidate relevance receipt. The durable record must make relevance and provenance separately inspectable.

**Inspect:**

- `backend/src/tools/discovery/select-code-graph-candidates.js`
  - `createSelectCodeGraphCandidatesTool`
  - `execute`
  - `receive`
- `backend/src/tools/discovery/subagent-evidence-sync.js`
  - `syncToolResultToEvidenceStore`
- `backend/src/tools/discovery/subagent-evidence-store.js`
  - `recordCandidateReceipt`
  - `recordDirectEvidence`
  - `snapshot`

### Finding O1-B: WeakMap receipt identity can be lost at serialization boundaries — Major

`candidateSourceMetadata(entry)` is backed by a module-private `WeakMap`. If a candidate crosses JSON, IPC, worker, or provider serialization, the object identity changes and the evidence synchronizer can return `not_recorded` even though the candidate was verified earlier.

**Required behavior:** preserve a Node-issued, non-forgeable receipt identity across the actual execution boundary, or guarantee that synchronization occurs before serialization. Add a regression test that passes candidates through the relevant transport boundary and proves that verified metadata still reaches the evidence store.

**Inspect:**

- `backend/src/tools/discovery/candidate-source-receipts.js`
  - `candidateSourceMetadata`
  - `registerCandidateSources`
- `backend/src/tools/discovery/subagent-evidence-sync.js`
  - `syncToolResultToEvidenceStore`
- `backend/src/tools/discovery/select-code-graph-candidates.js`
  - `receive`

### Finding O1-C: Mixed candidate batches need per-entry outcomes — Major

A single discovery result can contain fresh, stale, unauthorized, unreadable, and persistence-failure entries. The result must report each entry independently:

- verified source receipt or unavailable receipt;
- current SHA-256 and symbol map only for verified entries;
- evidence recorded, failed, or not-recorded separately;
- `active_file_checksums` updated only for verified fresh entries;
- no unverified entry may authorize `Read({ file_path, symbol })`.

Add a mixed-batch regression test covering at least: one verified file, one stale file, one unauthorized file, and one durable-store failure.

### Finding O1-D: Live cross-role demonstration is not yet proven — Major

Existing fixtures demonstrate AM/SE/RV-style evidence behavior, but they do not prove a fresh runtime sequence with distinct role sessions:

1. AM discovers and receives a verified candidate.
2. SE reuses durable evidence without trusting agent-supplied metadata.
3. RV reads the same evidence and confirms current SHA-256, symbol map, freshness, scope, and provenance.

Implement or expose a governed integration test for this sequence. Do not report fixture-only coverage as a live handoff demonstration.

## 3. O2 — Role, provider, scope, and snapshot access

### Finding O2-A: Ticket workspace wiring must be uniform — Major

The ticket workspace registry must receive the same `relevantTreeSelector` and `freshnessChecker` as the production supervisor path. Direct construction or test-harness construction must not fall back to `GRAPH_INDEX_UNAVAILABLE` or an unconfigured selector.

**Inspect:**

- `backend/src/modules/supervisor/ticket/ticket-workspace-service.js`
  - `createTicketWorkspaceService`
  - `create`
- `backend/src/modules/supervisor/production-runtime.js`
  - `createProductionSupervisorRuntime`
  - `createExecutionContextProvider`
- `backend/tests/integration/ticket-workspace-service.test.js`

Add a regression test that creates a workspace registry directly and successfully executes governed candidate discovery with freshness dependencies present.

### Finding O2-B: Provider capability matrices must be tested, not inferred — Major

Verify the same candidate capability contract across:

- owner conversation AM, SE, SL, RV, and Coder contexts;
- planning and explorer modes;
- Claude, Codex, Anthropic, and Ollama/function-calling paths;
- sender-worker and production supervisor paths;
- direct-code and immutable-baseline paths.

Positive cases must prove candidate discovery is available only when authorized. Negative cases must prove that direct-code, immutable scope, missing capability, missing implementation, and out-of-scope paths are rejected fail-closed.

**Inspect:**

- `backend/src/tools/roles/owner-role-tool-policy.js`
- `backend/src/tools/roles/owner-conversation-tools.js`
- `backend/src/tools/engineering-tool-catalog.js`
- `backend/src/tools/engineering-tool-binding.js`
- `backend/src/modules/supervisor/sender-worker.js`
- `backend/src/modules/supervisor/production-runtime.js`
- `backend/src/modules/supervisor/nodeforge-task-executors.js`
- `backend/src/modules/supervisor/function-calling-task-executor.js`

### Finding O2-C: Reviewer snapshot must never use the live working tree — Major

Reviewer candidate discovery, symbol extraction, and source receipts must remain bound to `review_commit_sha`. Add a real snapshot regression with an unstaged edit and an untracked file that would rank highly in the live tree. Assert that neither can appear in Reviewer candidates or receipts.

**Inspect:**

- `backend/src/modules/supervisor/review/reviewer-forge-tools.js`
- `backend/src/modules/supervisor/review/reviewer-snapshot-candidate-selector.js`
- `backend/src/modules/supervisor/review/reviewer-committed-source.js`
- `backend/src/modules/supervisor/review/review-worker.js`
- `backend/tests/unit/reviewer-snapshot-candidate-selector.test.js`
- `backend/tests/unit/reviewer-snapshot-discovery.test.js`

### Finding O2-D: WeakMap-backed evidence must remain valid for Reviewer reuse — Major

Reviewer handoff must not depend on the original candidate object identity. If Reviewer receives a serialized or durable candidate record, it must revalidate against the pinned source and create a new valid snapshot-bound receipt rather than silently losing provenance.

## 4. Retrieval stop policy — Major

The stop sequence must be observable and testable:

1. Reuse fresh evidence first.
2. Run bounded candidate discovery only when coverage is missing or evidence is stale.
3. Read verified symbols from the authoritative source.
4. Stop when freshness, scope, and acceptance-criteria coverage are sufficient.
5. Continue only for an explicit reason: stale evidence, missing coverage, failed symbolic read, or unresolved scope.

Add assertions showing that a valid candidate receipt plus a successful `Read(symbol)` prevents automatic repeated discovery. Also assert that stale or incomplete evidence is an explicit reason to continue.

**Inspect:**

- `backend/src/tools/discovery/delegated-discovery-policy.js`
- `backend/src/tools/discovery/exploration-state.js`
- `backend/src/tools/governance/runtime-tool-governance.js`
- `backend/src/tools/discovery/select-code-graph-candidates.js`
- `backend/src/tools/discovery/source-read.js`
- `backend/src/tools/discovery/subagent-evidence-tool.js`

## 5. Maintainability and verification findings — Minor/Major

- `backend/src/modules/supervisor/review/reviewer-forge-tools.js` is large enough to require an explicit repository line-budget check. Split bounded helpers if the applicable `AGENTS.md` rule is exceeded.
- `sender-worker.js` and `production-runtime.js` must not maintain a legacy capability list that diverges from the canonical engineering catalog.
- Verification reports must distinguish executed checks from authored documentation and fixture claims.
- A passed test result is not equivalent to clean-revision acceptance, isolated-environment provenance, or independent RV approval.

## 6. Required SE completion report

SE should return:

1. exact commit SHA and base SHA;
2. changed-path list excluding runtime/generated data;
3. focused test commands and outcomes;
4. evidence for O1-A through O1-D;
5. evidence for O2-A through O2-D;
6. retrieval-stop assertions;
7. verification artifact identifier and checksum;
8. known limitations, especially dependency/toolchain isolation.

## 6. Required SE completion report

SE should return:

1. exact commit SHA and base SHA;
2. changed-path list excluding runtime/generated data;
3. focused test commands and outcomes;
4. evidence for O1-A through O1-D;
5. evidence for O2-A through O2-D;
6. retrieval-stop assertions;
7. verification artifact identifier and checksum;
8. known limitations, especially dependency/toolchain isolation.

## 7. SE report — current evidence

**Report date:** 2026-11-11  
**Reviewed working-tree HEAD:** `7e2a8ed8d4942e8efa5671f6d42b1e605984850`  
**Clean revision status:** unavailable. The working tree is dirty and contains unrelated staged, unstaged, and untracked paths. No commit or push was attempted.

### Evidence available

- Round-3 handoff: [semantic-candidate-retrieval-r3-handoff.md](semantic-candidate-retrieval-r3-handoff.md), which records the pinned Reviewer retrieval repairs, their limitations, and the seven-file checksum manifest.
- Focused test artifact: `VERIFY-RUN-3ff03df2-cdd2-4ebf-b32b-67fb357823ec`, covering Reviewer snapshot candidate selection, candidate runtime access, candidate-source authority and receipts, and snapshot discovery.
- Focused lint artifact: `VERIFY-RUN-67089515-b7da-4740-a517-1cac682d15ee`, passed with zero warnings for the repaired retrieval and Reviewer files.
- The executed commands and source checksums are recorded in the round-3 handoff. These checks ran against working-tree bytes; they do not establish clean-commit acceptance or isolated dependency provenance.

### Finding disposition

| Finding | Current disposition | Evidence or remaining proof |
| --- | --- | --- |
| O1-A | Open | Durable synchronization must expose relevance and provenance receipts separately. The findings document remains the authoritative requirement; no independent acceptance evidence is recorded here. |
| O1-B | Open | WeakMap identity across serialization still requires a governed transport-boundary regression or synchronization before serialization. |
| O1-C | Open | Mixed-batch per-entry outcomes require a regression covering verified, stale, unauthorized, and persistence-failure entries. |
| O1-D | Open | A live AM → SE → RV sequence with distinct sessions has not been demonstrated; fixture coverage is insufficient. |
| O2-A | Open | Direct ticket-workspace construction still needs a regression proving configured selector and freshness dependencies. |
| O2-B | Open | The cross-role/provider capability matrix needs positive and fail-closed negative coverage across the listed paths. |
| O2-C | Partially addressed | Round-3 handoff records pinned lexical retrieval and tests that mutate live state without changing snapshot results. A clean committed revision and an explicit unstaged-plus-untracked snapshot proof remain required. |
| O2-D | Open | Reviewer reuse after serialization must revalidate against the pinned source and mint a new snapshot-bound receipt. |
| Retrieval stop policy | Open | The required stop/continue assertions are specified, but no complete evidence record proves that fresh receipt plus successful symbolic read suppresses repeated discovery in every governed path. |
| Maintainability and verification | Open | Line-budget, canonical capability-list, and exact-revision verification requirements remain unresolved. |

### Scope and acceptance limits

The changed-path set cannot be reported as an acceptance manifest because the current workspace includes unrelated runtime/generated data and other work in progress. In particular, `.forge/runtime/**`, SQLite sidecars, and `ui/nextjs/.next/**` remain present in the working-tree status and must be excluded by a governed commit operation before RV review.

The available focused checks establish behavior for the exercised tests only. They do not prove production migration, full-suite correctness, clean-revision reproducibility, isolated dependency/toolchain provenance, or independent Reviewer approval. The acceptance state therefore remains:

**Implemented — Open Findings — Pending SE Repair and RV Re-review**.
