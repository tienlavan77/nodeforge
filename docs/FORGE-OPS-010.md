# FORGE-OPS-010: Native dependency recovery

## Root cause

The repository lockfile already declared the platform packages for Linux x64, but
the local `node_modules` installation did not contain optional dependencies. The
host is `linux x64` on Node `v26.3.1`, so this was an incomplete npm install, not
a Node-version or architecture mismatch.

## Recovery

Run:

```sh
npm install --include=optional
```

This restored `@typescript/typescript-linux-x64` and both Linux x64 Rolldown
bindings used by Vite. A clean install must retain optional dependencies; avoid
`--omit=optional` for this project.

## Verification

All five delivery gates pass after recovery:

- `npm run validate:schemas` (50 schemas, 77 fixtures)
- `npm run lint`
- `npm run typecheck`
- `npm run build:web`
- `git diff --check`
