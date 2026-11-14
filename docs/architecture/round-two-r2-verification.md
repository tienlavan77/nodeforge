# Round-two repair verification

This artifact records the governed checks for the round-two repair patch.

- Base revision: `4a6741ce88610ff66e19d0cdaae2d7c9f2190928`
- Reviewed revision before repair: `b4c1b4a3db793dfc3cce99e2833f63c455a6d6a0`
- Repair commit: pending; Forge commit is blocked by a stale missing shell-snapshot path in the execution-scoped ledger.
- Generated/runtime paths are excluded from the implementation manifest.

## Implementation manifest

| Path | SHA-256 after repair |
| --- | --- |
| backend/src/modules/index/semantic-knowledge.js | 670d0a8526e5e05e7c96b05ff85269fdbc9383edcb790e0a2ac7dc931a06b1e1 |
| backend/src/modules/supervisor/review/reviewer-forge-tools.js | c24b1455e7df8c618a09ac405ac7f67eb3db2b23588582c2b3a8e3f5566eab50 |
| backend/src/modules/supervisor/review/reviewer-snapshot-candidate-selector.js | a645cd74fb9a51ff25540eb3d52564a7218eae0165483b41d9d4a7b69ab0f642 |
| backend/src/tools/discovery/select-code-graph-candidates.js | d3c4ee3d643871734004c853b230687d4fdcb7d32ce89f01a24b0714c735eafb |
| backend/tests/tools/candidate-source-receipts.test.js | 9c4c98df3dbd7c479439b766b6fe4519f4d383d2b0104eba37fbda0b963ccca6 |
| backend/tests/unit/reviewer-forge-tools.test.js | b6bb9716d03d310cce9b2aa355f4301ec0a5c6368806ff8fdc1f0421ff9ae696 |
| backend/tests/unit/reviewer-snapshot-candidate-selector.test.js | b486d1154340d34d2834348c5ec6b1682ed53f60907ef5fbc6dac6ce2b7863a5 |
| backend/tests/unit/retrieval-stop-policy-enforcement.test.js | 83daf5ff1bf9d37d7daaed0f1e20d041160d6abe9f62e5ee5c358381cb71239b |

## Executed checks

- `node --test backend/tests/tools/candidate-source-receipts.test.js backend/tests/unit/reviewer-snapshot-candidate-selector.test.js backend/tests/unit/reviewer-forge-tools.test.js backend/tests/unit/retrieval-stop-policy-enforcement.test.js`
- Result: passed; run `VERIFY-RUN-de1f17b1-f53e-40ae-a49d-d51b860376ef`.
- The AM → SE → RV handoff test passed, covering durable receipt reuse, exact source identity/scope, freshness, and Reviewer revalidation.
- The focused stop-policy test passed, covering the stop decision and no-retrieval result.

## Open commit limitation

`commit_changes` remains blocked before staging because its execution ledger contains the missing protected path:
`.forge/runtime/nf/sdk/codex-homes/885b2b5f-5247-4dfc-8f05-968de25391dc/conversations/CONV-SE-PLAN-PROJECT-NODEFORGE-f8201f66-792f-4fe8-8075-fb3b189244da/shell_snapshots/01a1d936-dbff-7270-99b3-5defcc54f094.1794645613594708352.sh`.
The repaired files and evidence are ready, but no commit SHA or push is claimed until that stale ledger entry is removed by the Forge runtime.
