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
admission error and approved scope. Node freezes and retains the normalized
acceptance criteria before verification admission, including their original
language and array order. Repair applies only each ticket's `verification_plan`;
other proposed changes are ignored and Sprint/ticket ID changes are rejected.
This prevents criteria from growing on each retry. Existing translated criteria
are retained, not silently removed; all final AC IDs still need relevant checks.
All coverage gates are rechecked before ingestion. There is no automatic repair
loop or RUN dispatch. Valid drafts still replay without regeneration after
storage failures or completed handoffs.

Verification steps are checked against the canonical ticket JSON schema at the
early coverage gate, not just at Sprint ingestion. Browser `viewports` are unique
positive integer widths in CSS pixels, e.g. `[375, 768, 1440]`, never objects,
strings or decimals. Invalid values are rejected without coercion. Older retained
drafts rejected at ingestion for a `verification_plan` schema error also enter
verification-only repair on the next owner-triggered Continue handoff; approved
criteria and all non-verification fields remain frozen.

Sprint `human_plan.components` must contain nonempty strings, not component
objects. If schema admission rejects object components, the next owner-triggered
Continue handoff requests a representation-only repair, applying only components
and retaining every entry, ticket, criterion and verification mapping. Invalid
repairs stay blocked. Outcome proof remains in ticket `coverage` and the exact
approved parent Markdown; the unsupported root `outcome_coverage` snapshot is
not sent to Sprint ingestion. Unknown root fields still fail schema validation,
with the offending property name included in the diagnostic.

## Development

The root workspace command starts all development processes with labelled logs:

```sh
pnpm dev
```

This runs the Control API (`:3100`), the filesystem Watcher/Code Index, and the
Next.js UI. The legacy Vite app remains available separately with
`pnpm dev:web` until the Next.js replacement is approved.
