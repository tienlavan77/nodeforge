<!--
Business purpose: Provides the runtime mirror of the Reviewer-readable revision-bound verification snapshot, run-ID reconciliation, and scoped diff manifest for PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c (r1, Round 4).
Technical description: Mirrors docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-verification.md with identical SHA-256 manifest, run-ID reconciliation, and Round 4 run_check receipts.
-->
# Verification & Review Snapshot — PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c (r1, Round 4)

- **Reviewer-Readable Artifact Path**: `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-verification.md`
- **Scoped Unified Patch Path (Reviewer-Readable)**: `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch.md` (`sha256:7b146718b79fe8b7df11fde868fa7a5bea02acec34cbf91f98d3ac52a488c51c`)
- **Runtime Mirror Path**: `.forge/runtime/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-R2-verification.md`
- **Plan ID & Revision**: `PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c` (`revision: 1`, `plan_sha256: 5a26caf72c0d2025fe253b738341844104ef9bae27e24ac20db47a1e9855865b`, `source_sha256: a1bd0c8c304a9082314c1c9cce4adf648a6f4bfd928fa8f0447b359d281c3ced`)
- **Handoff ID**: `HANDOFF-PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-R1`
- **Base Commit SHA (`ui-chat`)**: `131a628f042a27f0098df3dfb62f03a1a50223b4` (parent: `a53aeef27ba6a09c1d3634aa925e7e32fe5b9554`)
- **Source / Ledger Revision (`commit_id`)**: `OWNER-CONV-SE-PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-CORR-HANDOFF-PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-SE-R4`
- **Lineage / Correlation ID**: `CORR-HANDOFF-PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-SE-R4`
- **Dependency / Toolchain Provenance**:
  - Root `package.json`: `sha256:88144c0890199c3946c9509f6623dded5d3098bb6e07d72b18b599b642f3446c` (`total_lines: 35`, `code_lines: 34`)
  - UI `ui/nextjs/package.json`: `sha256:4b93549c3590fedee7ae4931d9b5a7632f55c9dc997663a0d7d563a51989631f` (`total_lines: 22`, `code_lines: 21`)

## 1. Round 4 Executed Node Verification Service (`run_check`) Receipts

| Check Type | Run ID | Evaluated At (UTC) | Status | Exit Code | Totals / Skips | Command |
| --- | --- | --- | --- | ---: | --- | --- |
| `test` | `VERIFY-RUN-860cdfa3-a5a0-4386-9e81-5a361a41e872` | `2026-11-02T11:16:18.268Z` | `passed` | `0` | `12` test files, `56` tests/scenarios (`56 passed`, `0 failed`, `0 skipped`) | `node --test ui/nextjs/tests/coding-workspace-layout.test.js ui/nextjs/tests/coding-workspace-layout-browser.test.js ui/nextjs/tests/coding-agent-panel-registry.test.js ui/nextjs/tests/conversations-navigation.test.js ui/nextjs/tests/coding-ticket-deletion.test.js ui/nextjs/tests/coding-sprint-deletion.test.js ui/nextjs/tests/coding-plan-approval.test.js ui/nextjs/tests/sprint-plan-panels.test.js ui/nextjs/tests/coding-agent-panel-presence-restore.test.js ui/nextjs/tests/workspace-navigation-headers.browser.mjs backend/tests/unit/browser-coding-layout.test.js backend/tests/unit/ticket-verification-runner-revision.test.js` |
| `lint` | `VERIFY-RUN-81efcfbc-e674-4c05-babd-b0bde5f7caa8` | `2026-11-02T11:16:19.202Z` | `passed` | `0` | `0 errors`, `0 warnings` | `pnpm exec eslint --rulesdir eslint-rules backend/src/modules/supervisor/browser/browser-coding-layout-fixture.js backend/src/modules/supervisor/browser/browser-coding-layout-scenarios.js backend/tests/unit/browser-coding-layout.test.js --max-warnings=0` |
| `typecheck` | `VERIFY-RUN-aa707757-d247-4a38-a0c0-38b1a782e7ca` | `2026-11-02T11:16:20.688Z` | `passed` | `0` | `0 errors` | `pnpm typecheck` |
| `build` | `VERIFY-RUN-edb275a0-9064-4f6c-ab35-c48734b7b808` | `2026-11-02T11:16:46.229Z` | `passed` | `0` | Next.js production webpack build succeeded | `pnpm --dir ui/nextjs build --webpack` |

### Run ID Reconciliation (Round 3 vs Round 4)

- `VERIFY-RUN-9c2d9dfe-51a8-4cea-9c3d-3226de2e0e0f` (`2026-11-02T11:08:44.821Z`): Round 3 pre-report test run recorded when writing the Round 3 verification artifact.
- `VERIFY-RUN-9568195e-e6d1-489c-a532-81d8a98500a3`: Round 3 post-report confirmation test run executed after updating the Round 3 verification artifact, which caused the Round 3 handoff text and report table to cite two different run IDs.
- **Canonical Round 4 Test Run ID**: `VERIFY-RUN-860cdfa3-a5a0-4386-9e81-5a361a41e872` (`2026-11-02T11:16:18.268Z`), bound to the exact 11 code/test file SHA-256 checksums in Section 2 below and cited identically in both this document and the Round 4 handoff.

## 2. Scoped File Manifest & Checksums (11 Scoped Code/Test Files, All `<= 400` `code_lines`)

| # | File Path | Status vs Base | Reviewed SHA-256 Checksum | `total_lines` | `code_lines` |
| ---: | --- | --- | --- | ---: | ---: |
| 1 | `ui/nextjs/app/coding/page.jsx` | Modified | `sha256:b7635b0f3f7418b8177a37e75f574011d0146ea18d33c564611b7699ad10e273` | 134 | 106 |
| 2 | `ui/nextjs/components/coding-workspace-monitor.jsx` | Modified | `sha256:ce4feacbd9b607d84aab418c70db7ef5aff453e1bb673479b6d4125c053ecdf4` | 84 | 71 |
| 3 | `ui/nextjs/lib/coding-workspace-activity.js` | New | `sha256:be55a0eb286cedef8848a0ed9286cf8f76342bb98cb93a23815edcc29b7cd72c` | 63 | 53 |
| 4 | `ui/nextjs/app/styles/workspace-monitors.css` | Modified | `sha256:2a02e6691bf24613d1b778e9a999e6f9818b00c3428c01b9aa557c89ee6b3176` | 98 | 90 |
| 5 | `ui/nextjs/tests/coding-workspace-layout.test.js` | Modified | `sha256:915ece1f3d7481425cfccca4d8d68954cafe4f47d64b29790acc7b1406d2ffbd` | 173 | 160 |
| 6 | `ui/nextjs/tests/coding-workspace-layout-browser.test.js` | Modified | `sha256:55256ed75d80bb689598251be479d145ff2dc1d72653b279576fe2810a877e06` | 249 | 236 |
| 7 | `ui/nextjs/tests/coding-agent-panel-registry.test.js` | Modified | `sha256:835fc87eaf48567a4083b0018c0a38cfceae6bb39121a785b60440886f8f6510` | 252 | 229 |
| 8 | `ui/nextjs/tests/conversations-navigation.test.js` | Modified | `sha256:f4f8b273ee3230ae791f308a73efd6be0f460ff2330b00e579efb80b77828190` | 256 | 243 |
| 9 | `backend/src/modules/supervisor/browser/browser-coding-layout-fixture.js` | Modified | `sha256:2c3880d85b3bb321b861070da8d18ab9149ef014106db8494260419f145e28ec` | 21 | 18 |
| 10 | `backend/src/modules/supervisor/browser/browser-coding-layout-scenarios.js` | Modified | `sha256:ea8dd80a2677b52c10c3ae6f4385ef1f6eaa34877856fe11464fa3407bb8cf2b` | 76 | 68 |
| 11 | `backend/tests/unit/browser-coding-layout.test.js` | Modified | `sha256:03aea239ef55ca960f7bc710b14becfdcfeb821c662b190af5df148d4d9190c2` | 19 | 15 |
