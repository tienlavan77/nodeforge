<!-- Reports the controlled legacy Sprint migration implementation and its verification/operational boundaries. -->
# Legacy Sprint Registry data migration

## Implementation

Implemented an additive maintenance flow restricted by the CLI to `PROJECT-NODEFORGE`:

- `backend/scripts/migrate-sprint-registry.mjs`: explicit preview/apply administrative entrypoint using existing runtime configuration.
- `backend/scripts/sprint-registry-migration-runtime.mjs`: read-only existing-database preview; offline apply holding Control API and watcher process locks; SQLite and plan/ticket backup plus hash manifest and completion receipt.
- `backend/src/application/sprint-registry-migration-preview.js`: source-bound manifest, explicit human-plan supplements and scoped blockers; no invented approval content.
- `backend/src/application/sprint-registry-migration-service.js`: exact manifest validation, backup-before-write, additive plan/Registry import and repeated-apply recovery.
- `backend/src/application/sprint-registry-migration-plan-recovery.js`: exact unindexed first-revision recovery without granting approval.
- Integration test and two fixture files cover CLI/runtime behavior, backup hashes, unchanged legacy source, approval rejection, stale source, process exclusion and abrupt death after file creation.

Legacy Roadmap and Ticket stores are retained. No approval decision, RUN, provider launch or status migration is performed. Imported Sprints await fresh human approval. Candidate retrieval metadata is excluded from immutable plan content consistently with the existing Plan Store.

## Verification and runtime result — migration PASS

Focused verification on the final code:

```text
node --test backend/tests/integration/sprint-registry-migration.test.js backend/tests/integration/sprint-registry-migration-preview.test.js backend/tests/integration/coding-registry-dashboard.test.js
```

Exit code `0`; **25/25 pass**. Captured TAP output SHA-256: `12849d730d131fa6be9483720fe6252a0f3b5a79392e9c1874010ba5716f900d`.

Scoped lint also exits `0`:

```text
node node_modules/eslint/bin/eslint.js --rulesdir eslint-rules backend/scripts/migrate-sprint-registry.mjs backend/scripts/sprint-registry-migration-runtime.mjs backend/scripts/start-control-api.mjs backend/src/application/registry-dashboard.js backend/src/application/project-dashboard-service.js backend/src/application/sprint-registry-migration-preview.js backend/src/application/sprint-registry-migration-service.js backend/src/application/sprint-registry-migration-plan-recovery.js backend/tests/fixtures/sprint-registry-migration-fixture.mjs backend/tests/fixtures/sprint-registry-migration-worker.mjs backend/tests/integration/sprint-registry-migration.test.js backend/tests/integration/sprint-registry-migration-preview.test.js backend/tests/integration/coding-registry-dashboard.test.js --max-warnings=0
```

`pnpm validate:schemas` exits `0`: 98 schemas and 91 fixtures validated. `git diff --check` exits `0`.

The final read-only preview used source-bound supplements and explicit ticket deletion events:

```text
node backend/scripts/migrate-sprint-registry.mjs preview --project PROJECT-NODEFORGE --supplements .forge/runtime/nf/sprint-migration/supplements-source-derived.json
```

Exit code `0`, `can_apply=true`, no blockers. Preview JSON SHA-256: `6787d21b90ec30107a989517191af73be85591023a7855dcfc6401d264a803b0`; embedded manifest SHA-256: `3a7a1cef079363a5eec2267a58f1e2ce87fc62458167f187d25724b92f034975`.

The exact manifest was applied with exit code `0`. Control API and watcher were already stopped; the CLI acquired its maintenance locks and released them on completion. It imported two immutable revision-1 plans and Registry records:

- `SPRINT-NF-UI-CONV-001` → `MIG-663fd1668b4679bf4eff8399f1bf258c128eccf9`, plan SHA-256 `c871c4272eda0bef91468863b9f80a953a616a0f2927f2093e1324ae7c41482e`.
- `SPRINT-CODEX-DOC-001` → `MIG-627300f5588eb25189dcdee3b44c3865a2d34949`, plan SHA-256 `b928029860f30ef556d96dd446c79e473c0d103df55f643b78faf0bb1524159e`.

Both Registry records and plans are `awaiting_human_approval`; each has zero approval decisions. Receipt explicitly records `approval_granted=false` and `execution_started=false`. The legacy Roadmap and Ticket records remain untouched. The 49 ticket records outside the latest Codex Sprint scope were retained and listed in the source-bound manifest using their matching `sprint-plan-service` `ticket.deleted` event IDs.

The legacy `style: ["frontend", "backend"]` on `TICKET-PROJECT-NODEFORGE-1790143726042` was normalized to the single primary `implementation_type: ["frontend"]`. The ticket's acceptance criteria remain unchanged; the rationale and owner-review caveat are in the immutable plan draft. Missing `human_plan` sections were supplemented from the latest Sprint objective, exact ticket titles/specs, exit criteria and the referenced UI convergence plan. The imported drafts remain unapproved for owner review.

Backup path: `.forge/runtime/nf/sprint-migration-backups/3a7a1cef079363a5eec2267a58f1e2ce87fc62458167f187d25724b92f034975-d1488b0b-50e2-4ab4-a45e-d04c911cde59`.
Backup and backup-manifest SHA-256: `384c8e0e8c8da4cbdedae42758f8fd93a895d23cd520115bdccfdbbc9db5fc82`; each backed-up file hash was rechecked and passed.
Receipt: `.forge/runtime/nf/sprint-migration-receipts/3a7a1cef079363a5eec2267a58f1e2ce87fc62458167f187d25724b92f034975-3b366f98-1cd0-491c-9e16-8b918c2638c5.json`.

Post-apply Registry dashboard service projection passed against the migrated runtime: 5 registered Sprints and 46 immutable ticket specs rendered, including both imports; no `SPRINT_REGISTRY_MIGRATION_REQUIRED` or `TICKET_PLAN_SCOPE` error. This is a direct application-service check; Control API was not started for an HTTP canary.

A fresh post-migration read-only preview exits `0` with `can_apply=true`, zero import entries and zero blockers, confirming an idempotent no-op on the migrated Registry. Post-migration preview JSON SHA-256: `6a60e7e262bfbd56614c3be6527b3f07b0a58b36abf338092eb712e88ea51449`.

## Operating instructions

Run from the repository root with the SAME `NODE_CONTROL_DATA_DIR` and project configuration as the serving Control API. Preview reads the existing database; it does not run schema upgrades.

```text
node backend/scripts/migrate-sprint-registry.mjs preview --project PROJECT-NODEFORGE
```

Save the JSON output as an operator-controlled manifest file. Preview exit 2 means blockers remain. Missing `human_plan` must be supplied explicitly as a JSON map keyed by Sprint ID:

```text
node backend/scripts/migrate-sprint-registry.mjs preview --project PROJECT-NODEFORGE --supplements migration-supplements.json
```

Review the manifest, runtime paths, ticket scope and source digest. Stop Control API and watcher through the deployment's normal maintenance procedure; the migration does not stop them itself. Resolve active/unknown execution outcomes before apply. Then:

```text
node backend/scripts/migrate-sprint-registry.mjs apply --project PROJECT-NODEFORGE --manifest migration-preview.json --sha256 EXACT_MANIFEST_SHA256
```

Never substitute an arbitrary checksum. Keep the original manifest for partial-import restart. A changed source or changed imported scheduling record requires reconciliation rather than automatic overwrite.

Backups are written under the configured data directory's `sprint-migration-backups/`; receipts under `sprint-migration-receipts/`. Backup hash manifest covers the SQLite snapshot, immutable plan tree, ticket history tree and captured source/preview. These contain private owner context: directories/files are created with restrictive permissions. Keep them out of Git.

## Restore and limitations

Restore is an operator maintenance action, NOT automatically implemented by this importer. Keep services stopped, verify backup hashes, archive the current database (including WAL/SHM state), current plans and tickets before restoring the backup database/tree. Do not restore a pre-import snapshot over subsequent writes; reconcile those writes first. Newly imported files must be retained/archived, not blindly deleted. No restore command or rollout was executed in this task.

Exclusive process locks cover participating Control API and watcher instances using the configured data directory. They do not fence arbitrary external SQLite/file writers or independently running provider processes. Maintenance requires these actors to be quiesced; retained launch claims are blockers. This is not an online cross-process migration transaction.

Preview/apply is exposed as a maintenance CLI, not a new MCP tool or public HTTP mutation endpoint. The current System Engineer Forge session cannot invoke this CLI. An authorized operator/background agent must execute it after verification; MCP registration remains a separate integration if direct in-session execution is required.

Runtime migration is complete. Production HTTP/UI canary and human approval of the two imported plan revisions remain outstanding. No legacy store/schema was retired. Migration code and tests are not committed.
