# NodeForge

NodeForge is a pnpm monorepo for project indexing, agent orchestration,
verification and a Next.js workspace UI. See [repository structure](STRUCTURE.md),
[architecture](ARCHITECTURE.md) and the [documentation index](docs/README.md).

## Architecture planning

Discuss the desired outcomes and constraints with Architecture Manager (AM).
Node coordinates clarification discovery and records the owner's decisions.
Plan generation uses JSON-first `architecture_manager.architecture_plan.v1`:
AM returns structured outcomes, scope, guardrails, dependencies and evidence;
Node validates the JSON, canonicalizes it and renders the retained Markdown
revision. AM does not save an authoritative plan file itself during generation.

Plan updates use RFC 7396 JSON Merge Patch against the canonical JSON.
Array values replace complete arrays, so updates must retain every intended
outcome and constraint. Node validates the resulting plan and records a new
revision. See the [JSON-first guide](workflows/architecture-plan-json-first-guide.md).

The existing `/plan path/to/discussion.md` entrypoint can consume a nonempty,
project-relative source document. Source integrity is bound to its recorded
checksum; source changes require a new draft. Creating a plan does not approve
it or dispatch work.

The owner reviews and approves an exact revision. Sprint Leader then creates
bounded tickets with dependencies, file budgets and verification mapped to
the final acceptance criteria. Continue handoff can repair rejected draft
representations while preserving approved scope and identities. Execution and
independent review use retained revision evidence; a focused test alone does
not establish completion of every required check.

Current role instructions are under [workflows/agents](workflows/agents/).
Historical plans and reports are retained under [workflows/archive](workflows/archive/).

## Development

Use Node.js 22.5 or newer and pnpm:

```sh
pnpm install
pnpm dev:foreground
```

The foreground controller starts the Control API, project watcher/code index
and Next.js UI with labelled logs. To run individual services:

```sh
pnpm dev:node
pnpm dev:watcher:foreground
pnpm --dir ui/nextjs dev
```

`ui/nextjs/` is the sole application UI. Selection persistence uses its
canonical `lib/architecture-manager-selection.js` module.

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm validate:schemas
pnpm --dir backend test
pnpm --dir ui/nextjs build
```

Backend lint and typecheck resolve the shared root installations of ESLint
and TypeScript. The postinstall bin repair script targets root
`node_modules/.bin`, independently of the caller's working directory.
