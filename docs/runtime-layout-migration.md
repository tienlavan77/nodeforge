<!-- Explains the functional runtime layout and offline migration recovery contract so operators
can regroup active Forge stores without rewriting evidence or losing rollback information. -->

# Runtime layout migration

The shared mapping lives in
`backend/src/infrastructure/filesystem/runtime-layout.js`.
It groups 30 stores under five roots:

| Root | Stores |
| --- | --- |
| tickets | ticket-changes, ticket-workspaces, ticket-execution-contexts, ticket-verification, ticket-integrations, ticket-root-commits, ticket-baselines, ticket-root-workspaces, ticket-run-dispositions, ticket-pipeline-shadow, ticket-pipeline-disposition, ticket-pipeline-rollout |
| reviews | review-records, review-dependency-reconciliation, ticket-review-findings, ticket-review-repairs, ticket-finding-repairs, automatic-review-locks |
| agents | agent-checkpoints, reviewer-checkpoints, agent-messages, agent-checkpoint-decisions, owner-executions, architecture-executions, supervisors |
| recovery | evidence-mapping-recovery, blocker-contract-decisions, blocker-context |
| backups | recovery-backups, repair-backups |

The leaf names stay unchanged. For example,
`.forge/runtime/agent-checkpoints/T.json` moves to
`.forge/runtime/agents/agent-checkpoints/T.json`.
Other runtime entries, including nf, wc, queues, protocol-storage,
processed-requests, reports, databases, and SDK/tool directories, stay in place.

## Compatibility

Without a marker, projects keep their existing flat layout.
`runtime-layout.json` selects the physical layout independently for each project.
FileService and direct verification filesystem consumers resolve historical store
paths through that marker. Receipts, checkpoints, hashes, and embedded references
are preserved byte for byte. Legacy FileService globs keep returning legacy names;
explicit grouped globs return grouped names.

Use `statePath(...)` for logical project-relative state references and
`resolveRuntimePath(projectRoot, ...)` for direct filesystem access.
Do not concatenate a project root with a stored runtime reference for raw file I/O.
All deployed readers and writers must include this compatibility implementation
before applying the migration.

## Inventory

From the project root:

```sh
node backend/bin/forge-runtime-migrate.mjs
```

This only inventories the current checkout. It never stops processes or moves data.
`migrationReady: false` means that inventory has not run the mutation gates.
The CLI deliberately has no arbitrary project-root argument.

## Apply during maintenance

Prepare an independent shell before stopping Control API and watcher, including
any service manager that would automatically restart them. Drain other writers.
An engineering session served by these daemons cannot perform its own shutdown.
Take the normal operational backup before maintenance; the migration journal
contains fingerprints and paths, not another copy of the evidence.

```sh
node backend/bin/forge-runtime-migrate.mjs --apply --offline
```

The command takes an exclusive fence, checks default nf daemon locks and
store/queue lock ownership, rejects duplicate endpoints and unsafe directory links,
and fingerprints every existing mapped store before moving anything.
Custom daemon data directories and writers without these locks must also be
stopped by the operator; the offline flag is an explicit maintenance assertion.

Unknown lock owners fail closed. Relative symlinks, links into moved stores,
Git worktrees, and special files require a separate relocation decision and
block apply before the first store move. Absolute dependency links into retained
project locations are preserved without following them.

The journal records endpoints, file counts, byte counts, and SHA-256
fingerprints covering contents, modes, empty directories, and link targets. Each rename is verified, and directory metadata is synced
before publishing the ready grouped layout. Missing stores are allowed; future
writes create them under their functional group. Repeated apply is a no-op once
the layout is grouped and no unexpected legacy stores exist.

## Verify and restart

Run inventory again: existing moved stores should be `already_grouped`, with
no conflicts or remaining planned moves. Verify checkpoint/review discovery
and a representative persisted verification read before enabling ticket writers.
Then restart the updated Control API and watcher and check their normal recovery.
Cleanup preserves all five group roots and migration metadata.

## Rollback and interrupted migration

Keep writers stopped while rolling back:

```sh
node backend/bin/forge-runtime-migrate.mjs --rollback --offline
```

Rollback validates the journal against the fixed mapping, locates each store
on either side of an interrupted rename, and verifies fingerprints before
moving anything back. It refuses collisions, missing endpoints, or evidence
changed after cutover. Once new state has been written, investigate and back up
that state before choosing another recovery procedure.

A marker with `status: migrating` blocks runtime access and daemon startup
even after the migration process exits. A killed process may also leave
`.forge/runtime/.runtime-layout.lock`. The command refuses to reclaim it:
verify that its recorded PID has exited, remove only that stale fence, and run
rollback. Do not remove the journal to bypass recovery.

Rollback removes only empty group roots recorded as created by that migration;
pre-existing group directories and unrelated entries are preserved.
