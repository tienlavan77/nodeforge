# Nodeforge project structure

Roadmap commits that write files must declare `target_path`, derived `target_dir`, and `file_operation` (`create`, `modify`, or `delete`). FileService rejects writes that do not match the commit target or its `allowed_change_areas`.

```text
nodeforge/
├── src/
│   ├── bootstrap/        # Composition root, configuration loading, lifecycle
│   ├── application/      # Command/event use cases; no transport or storage details
│   ├── domain/           # Project, task, session, rule and workflow policies
│   ├── modules/
│   │   ├── agents/       # Provider-neutral agent process protocol and streams
│   │   ├── context/      # Context selection, normalization, budgeting and cache policy
│   │   ├── events/       # Event publication, idempotency and subscriptions
│   │   ├── git/          # Change sets and diff collection
│   │   ├── history/      # Audit history, summaries and retention
│   │   ├── index/        # Incremental code index and dependency graph
│   │   ├── projects/     # Registry, project isolation and project state
│   │   ├── rules/        # Permission and workflow-rule evaluation
│   │   ├── verification/ # Test, build, lint and typecheck runners
│   │   ├── watcher/      # Filesystem events, debounce and stability checks
│   │   └── workflows/    # State-machine execution and handoffs
│   ├── infrastructure/   # Filesystem, SQLite, child process and OS adapters
│   ├── transport/        # HTTP/API, WebSocket/SSE and CLI adapters
│   └── shared/           # Error, IDs, logging and generic utilities
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── config/               # Nodeforge defaults; project-specific state is not stored here
├── scripts/              # Development and maintenance scripts
├── schemas/              # Versioned protocol contracts, grouped by bounded context
│   ├── core/
│   ├── node/
│   ├── project/
│   ├── context/
│   └── results/
├── rules/                # Committed default Node policy/rulesets
├── workflows/            # Committed workflow state-machine definitions
├── docs/
│   └── PROJECT_STRUCTURE.md
└── .forge/               # Created per monitored project at runtime; runtime is ignored
    └── runtime/
```

## Boundaries

- `src/modules/` implements Node's orchestration capabilities; an agent remains an external process that directly uses the target project's filesystem.
- `schemas/` is the protocol source of truth. `rules/` and `workflows/` are data validated against schemas rather than hard-coded control flow.
- `src/infrastructure/` is the only layer that knows SQLite, child-process, filesystem-watcher and network APIs. Runtime data belongs in the monitored project's `.forge/runtime/`, never in source control.
- `src/transport/` exposes state and streams but never becomes a source of truth; `modules/projects/`, the filesystem, Git and the event/history stores own that state.
