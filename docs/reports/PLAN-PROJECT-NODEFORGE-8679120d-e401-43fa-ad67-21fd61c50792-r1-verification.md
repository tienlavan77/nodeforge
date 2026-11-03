# Governed Verification Artifact — `ARTIFACT-6f78aa84c7260b5a439d142b116d9121ef67c3d1` (Round 3)

- **Artifact ID**: `ARTIFACT-6f78aa84c7260b5a439d142b116d9121ef67c3d1` | **Plan ID**: `PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792` (`r1`)
- **Source / Ledger Revision (`commit_id`)**: `OWNER-CONV-SE-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-CORR-HANDOFF-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-SE-R3`
- **Implementation / Review Commit SHA (`commit_sha`)**: `6f78aa84c7260b5a439d142b116d9121ef67c3d1` (`tree_sha: 7856fb31af0ca8813f9a3a941b07a4b42d8b9f9b`, `parent_sha: 73b927297f9d90784808e0e15d53accf63165d53`)
- **Declared Base Commit SHA (`base_sha`)**: `fe0df3f39ef7a203057a88e6722475cad047d6c0` (`base_tree_sha: e5b54a82be4116509639934abe445408d5a85e81`)
- **Canonical Manifest Digest (`manifest_sha256`)**: `sha256:448f9d8a45c63d22ed105bd634b43307285213b105f9110cfcc009b57a190706`
- **Snapshot Roots**: `.forge/runtime/reports/PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-r1-snapshot/6f78aa84c7260b5a439d142b116d9121ef67c3d1/` & `.forge/runtime/tickets/ticket-verification/PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792/snapshot/6f78aa84c7260b5a439d142b116d9121ef67c3d1/`

## 1. Per-File SHA-256 Checksum & Line Count Manifest (16 Scoped Files)

| # | File Path | `sha256` | `total_lines` | `code_lines` |
| ---: | --- | --- | ---: | ---: |
| 1 | `backend/scripts/control-api-project-runtime.mjs` | `sha256:ba671f1a65eddc7c03ffce2f826f5d1d577fa94b680f6f41757a3df66a0688d1` | 244 | 222 |
| 2 | `backend/scripts/start-control-api.mjs` | `sha256:487bc466681e42228d3c6a87e865e6fba920df7ddf3cfa87d5ae9d6744fa7b7c` | 254 | 234 |
| 3 | `backend/scripts/dev-foreground.mjs` | `sha256:f28df1369f19efc723a725facacdfa136a958cd75ce050359800a92778e2e345` | 404 | 353 |
| 4 | `backend/scripts/dev-foreground-view.mjs` | `sha256:439792cf3261155e9ee204af9e714d26a0eab51adcbebe8ad883b4e9af0952bf` | 199 | 175 |
| 5 | `backend/tests/unit/control-api-project-runtime.test.js` | `sha256:e1871a9bab3a4190fd85c9e1c08f4a0a520f09ef887b6179f31203696bab077c` | 337 | 293 |
| 6 | `backend/tests/unit/dev-foreground-view.test.js` | `sha256:53493d35e0db87f3ca50fc6eef900c0ce11daca18b6ec8454133c2645572769c` | 202 | 178 |
| 7 | `backend/src/modules/index/parser/index.js` | `sha256:d2d13813befc91a88926ff9da67f276c3485df91716e7e6f7ba00d34bf59c30b` | 50 | 38 |
| 8 | `backend/src/modules/index/incremental-indexer.js` | `sha256:36429257e30dc35d92a4a8dcd9275db2abbadf0d7cf8e0eaa4fce9126d3bbe7a` | 210 | 164 |
| 9 | `backend/src/modules/index/index-record-writer.js` | `sha256:ac1912d53961899d771796ba8b345733013b0b884fdd762ec0a7d0557a34308a` | 179 | 148 |
| 10 | `backend/src/modules/index/code-search.js` | `sha256:8d1d7aae233606a121376a0f5c24a220c5c79bd9dd56208a7f268a335aced17a` | 137 | 101 |
| 11 | `backend/src/modules/index/dependency-graph.js` | `sha256:61abf565c9a2639832b1b45fa8bc6ef637bc494fb1a22b74154a9e3412780630` | 38 | 30 |
| 12 | `backend/src/tools/governance/agent-lifecycle-tools.js` | `sha256:b2c6a5796ce6ddd4a6401363c7ace4c989fe82ff1626e719f4d1cea0decf6f84` | 227 | 193 |
| 13 | `backend/src/tools/discovery/agent-file-index-view.js` | `sha256:76b5f065a7985416e7530295f789f29c1244731827ffbed47ee7a6fe5dc480b7` | 30 | 24 |
| 14 | `backend/src/tools/roles/owner-conversation-tools.js` | `sha256:7d85e2e10b8eb6a435ce4d134bd72eba465e7840f0bf5e86b3499864108c69a0` | 108 | 99 |
| 15 | `backend/src/modules/supervisor/review/reviewer-forge-tools.js` | `sha256:021130eabbe54de7ac12974be2691e3aa566ef846c029ba8e92278e8f3062db1` | 249 | 217 |
| 16 | `backend/tests/unit/javascript-extractor.test.js` | `sha256:ba3fd1fb47c9621a798be4a36f8da53348439cd6d6608559f960d47dcd277609` | 132 | 108 |

## 2. Verbatim Split Unified Diff Parts (1–9, `<= 250` lines each, 1395 total diff lines)

| Part | Path | `sha256` | `total_lines` | Diff Lines |
| ---: | --- | --- | ---: | --- |
| 1 | `docs/reports/PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-r1-scoped-patch.md` | `sha256:c9cf445684b9a6064858e024b004b45f3d5a12460ac485e77593447741451b5e` | 165 | 1-155 |
| 2 | `docs/reports/PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-r1-scoped-patch-part2.md` | `sha256:187d5c81f0c7842c1dc40d310f67dc56c80732142ccbb3889eedb2b78035e8ce` | 165 | 156-310 |
| 3 | `docs/reports/PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-r1-scoped-patch-part3.md` | `sha256:90351c8ca25777862b97cb9638c7ae0e84229e09f05549fa0506b98e7f3cf653` | 165 | 311-465 |
| 4 | `docs/reports/PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-r1-scoped-patch-part4.md` | `sha256:cb4da327410558fbc4b3926e3f699f476ee68f496ad1d7ee608020087f45df12` | 165 | 466-620 |
| 5 | `docs/reports/PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-r1-scoped-patch-part5.md` | `sha256:da1b070d144bf7649766c1e291ecbf4a87768a6b7b7d3a1a9d4b976810526efc` | 165 | 621-775 |
| 6 | `docs/reports/PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-r1-scoped-patch-part6.md` | `sha256:030cb268a9bf2c459c63a9396d1dabcda7a68305fba539e98674e8d0968bbc8c` | 165 | 776-930 |
| 7 | `docs/reports/PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-r1-scoped-patch-part7.md` | `sha256:4a40afdae17ccf74a7ae04a925d131f1dd8a77986e86f762206b5a4273d1ffc8` | 165 | 931-1085 |
| 8 | `docs/reports/PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-r1-scoped-patch-part8.md` | `sha256:bc0b5da5e42386e9efb20ee38a97e2261756f7d0ad1280677f9d9250c0c7a905` | 165 | 1086-1240 |
| 9 | `docs/reports/PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-r1-scoped-patch-part9.md` | `sha256:d94755e4bc55ab14567717f37dc9dbd9f0e6a2eeb54cb4bcc82cf7a85df95c77` | 165 | 1241-1395 |

## 3. Durable Test, Lint & Typecheck Receipts (Reconciled Across R1, R2, R3)

| Kind | Round 3 Run ID | Round 2 Post-Commit (02:01Z) | Round 2 Pre-Commit (01:55Z) | Round 1 Run ID | Status | Receipt Path |
| --- | --- | --- | --- | --- | --- | --- |
| `test` | `VERIFY-RUN-02e7a4a5-56cd-4b2e-8c36-0324ff0f8d38` | `VERIFY-RUN-e74f03fc-0a17-4e67-a56a-984bfceb2d5b` | `VERIFY-RUN-7f7b51b2-b718-49bc-b634-849a6aef79d6` | `VERIFY-RUN-20671e77-5de6-45fa-a0fc-27671f06df78` | `passed` (`0`) | `.forge/runtime/tickets/ticket-verification/PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792/checks/VERIFY-RUN-02e7a4a5-56cd-4b2e-8c36-0324ff0f8d38.md` |
| `lint` | `VERIFY-RUN-81e9b3d2-2f43-4727-bdfd-c736e040d252` | `VERIFY-RUN-81e9b3d2-2f43-4727-bdfd-c736e040d252` | `VERIFY-RUN-4e38c202-4969-48b6-8f84-d13f0f6832f4` | `VERIFY-RUN-ecde66f0-e369-4d3d-9870-8980df7ca0b2` | `passed` (`0`) | `.forge/runtime/tickets/ticket-verification/PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792/checks/VERIFY-RUN-81e9b3d2-2f43-4727-bdfd-c736e040d252.md` |
| `typecheck` | `VERIFY-RUN-b637ddcc-aa6f-4358-8b4c-af1b66b3a705` | `VERIFY-RUN-b637ddcc-aa6f-4358-8b4c-af1b66b3a705` | `VERIFY-RUN-4dbd197b-8f22-4e9d-9fd2-caf879747d18` | `VERIFY-RUN-4dbd197b-8f22-4e9d-9fd2-caf879747d18` | `passed` (`0`) | `.forge/runtime/tickets/ticket-verification/PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792/checks/VERIFY-RUN-b637ddcc-aa6f-4358-8b4c-af1b66b3a705.md` |
