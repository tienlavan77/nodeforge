<!-- Documents the implementation mapping and fresh verification evidence for the approved semantic candidate retrieval plan so the owner and independent Reviewer can assess completion and runtime limits. -->
# Semantic candidate retrieval — 998a13a3 r1

Recipient: Owner and Architecture Manager; available for independent Reviewer inspection.

Plan: `PLAN-PROJECT-NODEFORGE-998a13a3-3a73-41eb-9343-1a7f11d2bdee r1`.
Requested source: `.forge/runtime/nf/plans/PLAN-PROJECT-NODEFORGE-998a13a3-3a73-41eb-9343-1a7f11d2bdee/plan-source-r1.json`.
Source SHA-256: `0fc50ca0df81401a6dce49b1d9e97626e8d8def08ca0f70374f86bbbe3eea169`.
Verification date: 2026-11-11 UTC.

## Implementation disposition

The required O1/O2 implementation already exists in the supplied repository state. This execution reuses that implementation and adds this plan-specific evidence report; it does not rewrite existing source or claim authorship of prior changes.

Fresh source metadata was reused from the shared evidence store, including System Engineer workers `parent:885b2b5f-5247-4dfc-8f05-968de25391dc`, `885b2b5f-5247-4dfc-8f05-968de25391dc:sub:candidate-evidence-validation` and `885b2b5f-5247-4dfc-8f05-968de25391dc:sub:current-role-access`. Primary receipt and synchronization symbols were read directly in this execution.

## Acceptance mapping

| Outcome | Implementation and evidence |
| --- | --- |
| O1: valid source receipt signature | `backend/src/tools/discovery/candidate-source-receipts.js` imports `recordSourceMetadata` and calls `recordSourceMetadata(context, metadata)` after authorized source reading, SHA-256 hashing and symbol extraction. The selector delegates to this helper rather than importing the receipt function itself. |
| O1: automatic durable evidence sync | `select-code-graph-candidates.js` routes both ticket-cache and retrieval results through `receive`; `subagent-evidence-sync.js` recognizes the candidate tool and persists only privately verified metadata. Receipt validity and durability have separate statuses. |
| O1: active checksums | Receipt registration updates execution checksums. `owner-conversation-tools.js` persists verified candidate checksums to conversation state; ticket/Reviewer bindings preserve checksum context. |
| O2: owner/planning/explorer access | Candidate retrieval is present in `owner-role-tool-policy.js`, planning/explorer lists and the owner registry implementation. |
| O2: Coder access | Candidate capability is available during mutable discovery; `direct_code` and immutable baseline gates remain. Existing V2 Coder project-read policy remains authoritative; legacy allowed path lists are not substituted for issued V2 authority. |
| O2: Reviewer access | Reviewer registry and worker bind the selector; snapshot discovery and symbolic reading use the fixed committed source. |
| O2: retrieval stop policy | Role READMEs describe reuse of fresh evidence, verified receipts, symbolic reading and stopping once acceptance coverage is sufficient; stale or incomplete evidence permits justified scoped discovery. |

No ONNX model weights or index.db storage schema were changed by this execution.

## Fresh verification

Result: **PASS**, exit code **0**.
Run: `VERIFY-RUN-ef281f60-b0d1-4b93-a869-e331f58d1438`.
Evaluated at: `2026-11-11T00:02:18.336Z`.
Forge reported commit: `856334a53bddfa4f0c5975506869eeab90fc62c6`.
Forge reported base: `1a8d1932b53c9a65590abbf208a73d0b6943f8eb`.

```text
node --test backend/tests/tools/candidate-source-receipts.test.js backend/tests/tools/candidate-source-authority.test.js backend/tests/unit/candidate-runtime-access.test.js backend/tests/tools/select-code-graph-candidates.test.js backend/tests/unit/coder-unified-forge-tools.test.js backend/tests/unit/sender-worker-retrieval-tools.test.js backend/tests/unit/reviewer-candidate-worker.test.js backend/tests/unit/reviewer-snapshot-candidate-selector.test.js backend/tests/unit/reviewer-snapshot-discovery.test.js
```

Nine test files were selected. Forge returned command-level PASS without individual case counts; no case total is inferred.

The selected receipt suite includes `AM to SE to RV handoff preserves exact source identity, scope and freshness`, live/cache receipt registration, stale/unreadable/out-of-scope rejection, durability failure and fabricated metadata rejection. Other selected suites cover role registry access, Coder SDK/sender wiring and fixed-source Reviewer discovery.

## Limits and remaining acceptance

- The original run is fixture/integration-test evidence, not a demonstration with three live model sessions. During round 2, the current SE session successfully invoked `select_code_graph_candidates`; three entries returned verified receipts and recorded durable evidence. The requested real AM → SE → RV demonstration remains unverified.
- Reviewer snapshot retrieval preserves the fixed source using lexical retrieval; the existence of embeddings method names does not establish semantic inference on the snapshot.
- The working tree was already dirty, including source changes overlapping this feature and unrelated staged changes. They were preserved. The verification receipt reports the commit above, but this execution does not claim all inspected working-tree bytes are committed or that the tree is clean.
- No new application code was needed for the inspected acceptance mapping. No lint, build, full suite, production deployment, migration or model-provider session was run in this execution.
- No commit or push was performed in the original execution.

## Round 2 repair

The repair adopts the existing pinned-corpus implementation and ticket-cache opt-out into the submitted change. It additionally filters prior/dependency hints against the pinned corpus before ranking. Regression coverage checks unchanged results across live-index changes, select-only fallback, source failures, live-only hints and registry-level ticket-cache bypass.

The six-file focused command covers snapshot selector/discovery, runtime access, candidate selection, receipt registration and source authority. Forge reported PASS (exit 0) as `VERIFY-RUN-ed2f41de-2720-4dd4-988b-193c5a1b9e24`. This pre-commit receipt identifies old HEAD `856334a53bddfa4f0c5975506869eeab90fc62c6`; it does not certify the repaired commit or an isolated source manifest.

A separate governed `run_command` invocation requested the same tests with a 60000 ms timeout. It did not return a result after several minutes; the waiting orchestration was terminated. No test-case count or command-service PASS is claimed.

Current live SE candidate discovery returned verified receipts and durable recorded evidence for the snapshot selector, candidate receipt helper and planning service. This corrects the original report's missing-tool statement. Fresh AM/RV session advertisement and the live AM → SE → RV handoff still require actual role sessions; explorer workers are SE subagents and cannot substitute for those roles.

Acceptance remains pending exact-revision durable verification and the live three-role demonstration. A post-commit receipt, if obtained, must be assessed with its actual manifest/isolation limits rather than inferred from its commit label.
