<!-- Documents the approved lifecycle foundation split and preserves the original combined acceptance gate. -->
# Multi-project lifecycle foundation

Status: **BLOCKED / NOT ACCEPTED FOR PRODUCTION** for the original ticket
`TICKET-MULTIPROJECT-A-R1-LIFECYCLE`.

The owner-selected `approved_split` permits the internal foundation package to
be implemented independently. It does not authorize management HTTP endpoints,
CLI command syntax, schemas, errors, or compatibility changes. No original
criterion is removed or downgraded. Foundation tests are not transport receipts.
Both packages must have accepted receipts before the original ticket can close.
Canary, terminal receipt, and release authority evidence remain required for
production acceptance.

## Foundation composition

`createProjectLifecycle` in `src/modules/projects/project-lifecycle.js` opens an
explicit `catalogPath`, restores its projects, and returns internal `add(root)`,
`remove(root)`, `list()`, `get(root)`, and `close()` operations. This is an
in-process composition capability, not an approved public transport contract.
The caller owns the manager and must await `close()` on shutdown. Control API
composition can pass it as `projectLifecycle` to `startControlApi`; shutdown then
awaits all project runtimes even if another resource fails, removes signal
handlers, and clears the HTTP shutdown fallback timer. This adds no route.
Use one manager
per global catalog; concurrent processes writing the same catalog are unsupported.
Keep the global catalog outside per-project runtime directories. It stores only
canonical roots and project IDs, not database handles, workers, or stream state.

Admission resolves symlinks, reuses `ProjectRegistry` identity, reconciles the
baseline, and starts one watcher pipeline, bus, database, and durable embedding
worker per project. Successful admission persists catalog membership atomically.
Concurrent admission/removal is serialized. Catalog-write failure rolls the new
runtime back without deleting the per-root identity. A copied identity cannot be
registered for two roots. Failed restart entries remain in the catalog, appear in
`startupErrors`, and do not prevent unaffected roots from serving. Retry via `add`
or remove the failed entry explicitly. `list` reports only serving runtimes.

`get(root)` exposes a project-local runtime for future Control API composition.
Its `connect` method wraps the existing project SSE projection, including the
index snapshot, without registering any new route. The runtime owns these stream
handles; client disconnect or runtime removal closes subscriptions and heartbeat
timers. Runtime databases and search dependencies are never shared across roots.
The legacy single-project watcher and CLI entry points remain available unchanged.
The default Control API startup does not automatically enable this foundation;
its management integration belongs to the dependent transport package.

An unavailable Ollama endpoint produces project-local worker diagnostics and
retryable durable jobs. It does not block watcher startup or unrelated projects.
Removal stops event admission, drains index work and pending hash reads, cancels
Ollama requests, awaits worker completion, and closes the database. A supplied
custom embedding provider must implement `close()` if its `embed()` can remain
pending; production Ollama providers implement cancellation. Removal retains
per-root identity and on-disk index data. Shutdown retains global membership for
restart; explicit removal removes global membership. Cleanup failures are
reported, not swallowed. A failed cleanup or catalog removal must be investigated
before retrying admission; no claim of successful removal is made on failure.

## Immutable acceptance coverage map

| Original criterion | Foundation package | Dependent transport/thin-CLI package | Combined gate |
| --- | --- | --- | --- |
| AC-1 | Stable identity, catalog, baseline, watcher rename/delete/error recovery, per-project embedding worker and bus, internal project snapshot/SSE, two serving runtimes, removal cleanup | Control API management composition and real thin-client add/remove/list using approved contract | Pending both receipts |
| AC-2 | Single-project compatibility; duplicate admission, restart, partial failure, repeated removal, shutdown, resource cleanup, isolated unavailable Ollama | Compatibility and process-level integration receipts for the approved transport | Pending both receipts |
| AC-3 | No new public API; changed files at most 250 lines; actual manifest includes source, tests, and this documentation | Approved identifiers, schemas, errors, and transport compatibility tests; manifest governance | Pending governance and both receipts |
| AC-4 | Same internal lifecycle capabilities as AC-1, including project-local stream projection | Management invocation through the Control API process | Pending both receipts |
| AC-5 | Removal releases resources; two runtimes in one process | Real CLI delegates add/remove/list; mocked delegation is not acceptance | Pending both receipts |

Focused executable coverage is rooted at
`tests/integration/multi-project-lifecycle.test.js`, including the imported failure
suite. It exercises real SQLite databases, filesystem watchers, indexers, workers,
and stream projections, with deterministic embedding endpoint substitutes and
Linux descriptor assertions. It does not prove real Ollama availability, public
Control API management, CLI transport, canary behavior, or production acceptance.

The transport package remains blocked until the owner supplies approved
identifiers, schemas, errors, and compatibility tests. Do not invent endpoints,
route aliases, prefixes, or payloads to bypass that gate.
