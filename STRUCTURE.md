# NodeForge repository structure

This pnpm workspace contains the backend and the Next.js application.
Workspace membership is defined by `pnpm-workspace.yaml`.

```text
nodeforge/
├── backend/
│   ├── src/
│   │   ├── bootstrap/       Composition and service lifecycle
│   │   ├── application/     Application use cases and orchestration
│   │   ├── modules/         Governance, agent, indexing and supervisor verification
│   │   │   └── supervisor/ Core orchestration and queues
│   │   │       ├── browser/ Browser verification and coding scenarios
│   │   │       ├── coder/   Coder dispatch and dependency repair
│   │   │       ├── blocker/ Blocker reconciliation, recovery and escalation
│   │   │       ├── review/  Review gates, workers and evidence
│   │   │       └── ticket/  Ticket lifecycle, workspaces and verification
│   │   ├── tools/
│   │   │   ├── discovery/   Governed file, search, index and exploration tools
│   │   │   ├── roles/       Owner, Coder, Reviewer and Sprint Leader SDK bindings
│   │   │   ├── reporting/   Reports, review responses and verification evidence
│   │   │   └── governance/  Authorization, lifecycle, mutations and conventions
│   │   ├── infrastructure/  Filesystem, Git, SQLite and process adapters
│   │   ├── transport/       HTTP, SSE and CLI interfaces
│   │   └── shared/          Shared errors and utilities
│   ├── tests/              Unit, integration, tools and evaluation tests
│   ├── scripts/            Development, verification and maintenance scripts
│   └── bin/                Backend maintenance entrypoints
├── ui/nextjs/              Canonical Next.js application
│   ├── app/                Routes and styles
│   ├── components/         UI composition
│   ├── lib/                Client state and API helpers
│   └── tests/              UI and state regression tests
├── schemas/                Versioned protocol and tool contracts
├── workflows/
│   ├── agents/             Runtime role instructions at stable paths
│   ├── archive/            Historical plans, reports and discussions
│   └── README.md           Workflow guidance
├── docs/
│   ├── architecture/       Detailed architecture references
│   ├── archive/            Historical documentation collections
│   ├── assets/             Documentation images
│   └── README.md           Documentation navigation
├── eslint-rules/           Repository lint rules
├── vocabulary/             Standard business-to-code terminology
├── config/                 Committed configuration
├── rules/                  Committed policy data
├── package.json            Root development and verification commands
└── .forge/runtime/         Local runtime data, retained outside source control
```

The backend source stays under `backend/src/`. The stream bridge is in
`modules/agent/`; `modules/supervisor/supervisor-adapter-registry.js` identifies
the supervisor adapter registry separately from the agent registry.
Tools share their root catalogs and entrypoint. `tools/execution-file-access.js`
keeps its implementation at the historical path for security baseline integrity.
Supervisor domain modules now live in `browser/`, `coder/`, `blocker/`,
`review/` and `ticket/`. Core orchestration and queues remain at the supervisor
root (39 modules), as approved by Owner and AM. B.3.1–B.3.5 are accepted;
B.3.6 dependency/cycle audit and final verification are complete. Phase B is
ready for Owner/AM acceptance. See [the final Phase B report](docs/se-phase-b-final-report.md)
for evidence, existing cycles and retained runtime-test limitations.
Runtime guidance in `workflows/agents/` and `workflows/README.md` remains at
its original paths.

Filesystem and Git retain source evidence. Node's index supports retrieval;
transport and UI expose state owned by the backend services and stores.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the architecture overview and
[docs/README.md](docs/README.md) for design and historical references.
