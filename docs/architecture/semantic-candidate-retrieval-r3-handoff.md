<!-- Records the round-3 candidate retrieval repairs and their working-tree verification limits for the owner and Reviewer. -->
# Round 3 engineering handoff

Recipient: project owner and Reviewer. Status: repairs implemented; committed acceptance remains blocked.

Reviewed HEAD: `856334a53bddfa4f0c5975506869eeab90fc62c6`.
Original review base: `1a8d1932b53c9a65590abbf208a73d0b6943f8eb`.

## Repairs

1. Removed the unused imports of the uncommitted conversation directive module and the ticket directive inbox from owner conversation tools. Owner-tool candidate access tests load the module successfully in the current workspace. A clean committed checkout has not been tested.
2. Replaced live-shortlist filtering with retrieval over authorized pinned source bytes before ranking. Uses the shared lexical scoring rules with pinned path, symbol and content searches. Returned scores, reasons, symbols, node fields and revision identity originate from this corpus. Live embeddings, graph edges and freshness metadata are not used. Ticket candidate caches are disabled for snapshot retrieval, including their use as prior-file ranking seeds.
3. Preserved the wrapped selector's supported method surface. Each exposed method performs pinned retrieval; the select-only fallback is awaited. Tests mutate live rankings, paths, symbols and freshness and assert identical results with zero live selector calls. The existing candidate runtime fixture now also carries a live-only cached candidate.
4. Updated the snapshot discovery fixture to valid JavaScript and the current metadata and symbolic-read API.

Snapshot retrieval currently performs a pinned lexical scan per request, with no semantic or dependency-graph expansion. The Reviewer source's existing read limits remain in force; protected, missing and oversized files are excluded. Unexpected source errors propagate. Production-scale scan performance has not been benchmarked.

## Executed checks

Focused tests passed on 2026-11-10:
`VERIFY-RUN-3ff03df2-cdd2-4ebf-b32b-67fb357823ec`.

```text
node --test backend/tests/unit/reviewer-snapshot-candidate-selector.test.js backend/tests/unit/candidate-runtime-access.test.js backend/tests/tools/candidate-source-authority.test.js backend/tests/tools/candidate-source-receipts.test.js backend/tests/unit/reviewer-snapshot-discovery.test.js
```

Focused lint passed with zero warnings:
`VERIFY-RUN-67089515-b7da-4740-a517-1cac682d15ee`.

```text
pnpm exec eslint --rulesdir eslint-rules backend/src/modules/supervisor/review/reviewer-snapshot-candidate-selector.js backend/src/modules/supervisor/review/reviewer-forge-tools.js backend/src/tools/discovery/select-code-graph-candidates.js backend/src/tools/roles/owner-conversation-tools.js backend/tests/unit/reviewer-snapshot-candidate-selector.test.js backend/tests/unit/candidate-runtime-access.test.js backend/tests/unit/reviewer-snapshot-discovery.test.js --max-warnings=0
```

The initial focused runs exposed the obsolete fixture API and invalid fixture JavaScript; both were corrected. The initial lint invocation omitted the custom rule directory and also exposed an unused import; the final invocation above passed. No full-suite or full-lint result is claimed.

These checks executed current working-tree bytes. The owner run_check implementation reports HEAD and its parent as metadata without binding a file manifest or isolated checkout. Its ready_for_review value does not prove these repairs exist in that commit.

## Source checksum manifest

SHA-256 values for the seven repaired source and test files, excluding this handoff:

| Path | SHA-256 |
| --- | --- |
| backend/src/modules/supervisor/review/reviewer-forge-tools.js | 513732230aebcb4616cbdbf59122acceb1e6df2106a1f80fac6c981dc870c1da |
| backend/src/modules/supervisor/review/reviewer-snapshot-candidate-selector.js | 3f127ebcd926cb9fb47bd309e258921b7e3a0dacd560ac19fd895f342a4987e3 |
| backend/src/tools/discovery/select-code-graph-candidates.js | 6634a64fd3738979fdc023de956d80b46418bb96efce27babc503c89bd2b5003 |
| backend/src/tools/roles/owner-conversation-tools.js | 5967b2f4cf2c39b17f13f893a4e86dbaa98d8dda6af6b1a1b36f6489d595c0ba |
| backend/tests/unit/candidate-runtime-access.test.js | 57cfb4f4b2ad5202f1c2191d13080870e991bd6c4cf7561fe9959c1d9411cd73 |
| backend/tests/unit/reviewer-snapshot-candidate-selector.test.js | dbeb3e771b56cdb693c31d0b5b466be44ea6d4a02d50e75307b0538cf5092520 |
| backend/tests/unit/reviewer-snapshot-discovery.test.js | 3a0898b0b9a3dd9c2abe4c52b86ba7aaf4436a3befa472ef726bc458a04b68c2 |

This human-readable manifest is supplementary engineering evidence, not a Node-issued verification artifact.

## Open findings and required platform capability

Finding 4 remains open. Exact-revision git_show confirms four runtime paths were added in HEAD: two owner execution files, the system engineer evidence store and one conversation history file. Local runtime data has been preserved. The supplied git_restore rejected even an unstage request for one exact runtime path with GIT_PROTECTED_PATH. The supplied Git interface has no untrack-while-preserving-local-data operation and no commit-path input.

The inherited owner commit ledger still includes runtime paths. commit_changes would force-add the recorded paths; invoking it would risk repeating the runtime inclusion. No commit or push was attempted.

Finding 5 remains open. Searches of .forge/runtime/nf/verification and .forge/runtime/reports found no occurrence of VERIFY-RUN-dfe458f7-e398-41b2-b46f-9ae240c429d1. Its complete artifact has not been recovered or validated. The checks above do not establish exact-revision acceptance.

To finish: provide a governed Git operation to remove the four runtime paths from the submitted tree while retaining local bytes, and a commit scope containing only this authorized repair. Then create the corrected fixed revision, verify owner module loading from that revision, rerun the focused checks in an isolated committed source, publish its base/revision/manifest/checksum evidence, and return it for independent review. Unrelated staged and unstaged changes must remain intact.
