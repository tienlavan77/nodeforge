# FORGE-OPS-001a - Legacy `.node-control` audit

## Result

The legacy `.node-control` directory was removed from the working tree after confirming that runtime persistence uses `.forge/runtime/nf` for Control API data and `.forge/runtime/wc` for watcher/index data.

## Reference audit

Remaining `.node-control` references are non-runtime safeguards or historical documentation:

- `.gitignore` ignores the legacy directory.
- `src/infrastructure/filesystem/watcher.js` and `src/infrastructure/filesystem/file-service.js` ignore it to prevent indexing or writing legacy state.
- `tests/unit/filesystem-watcher.test.js` verifies ignored legacy paths.
- Sprint/docs/schema example text contains historical migration or acceptance-criteria references.

No Control API, Watcher, FileService, or Indexer data path resolves to `.node-control`; all live paths come from `NODE_CONTROL_DATA_DIR` (default `.forge/runtime/nf`) and the watcher index path `.forge/runtime/wc`.

## Verification

- `npm run validate:schemas` passed.
- `npm run lint` passed.
- `npm run typecheck` passed.
- `npm run build:web` passed.
- `git diff --check` passed.
