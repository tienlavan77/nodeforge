# Nodeforge

Repository for the Nodeforge project.

## Architecture planning

Discuss the scope with Architecture Manager (AM) in normal chat, then ask AM to
summarize it and save a Markdown file at an agreed path in `docs/` or `workflows/`.
There is no backend `/summary` command and no generated SUMMARY ID is needed.

Create a reviewable plan from that existing file:

```text
/plan workflows/discussion-feature.md
```

The argument is a project-relative `.md` file path, not the output plan path.
The file must be readable through Node File Service and non-empty; absolute
paths, traversal, external URLs, and SUMMARY IDs are rejected. The source does
not need the old Discussion Summary heading or seven-section template.
During `/plan`, AM has read-only discovery tools and returns plan Markdown;
NodeForge validates and persists the draft with the source path and SHA-256.
Generated plans still require discovery evidence, scope and labeled uncertainty.
Saving a summary or creating a draft does not approve a plan or start RUN.
Exact owner approval and handoff remain separate steps. Editing the source after
plan creation requires a new draft before approval because source integrity is
checked against the recorded checksum.

Sprint Leader must number verification checks against each ticket's final
acceptance criteria, including the exact approved outcome criteria. If handoff
rejects a draft for an invalid verification plan, the next owner-triggered
Continue handoff asks Sprint Leader to repair that retained draft with the
admission error and approved scope. Sprint and ticket IDs must stay unchanged;
all coverage gates are rechecked before ingestion. There is no automatic repair
loop or RUN dispatch. Valid drafts still replay without regeneration after
storage failures or completed handoffs.

## Development

The root workspace command starts all development processes with labelled logs:

```sh
pnpm dev
```

This runs the Control API (`:3100`), the filesystem Watcher/Code Index, and the
Next.js UI. The legacy Vite app remains available separately with
`pnpm dev:web` until the Next.js replacement is approved.
