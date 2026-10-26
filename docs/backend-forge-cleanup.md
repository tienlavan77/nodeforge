<!-- Records removal of duplicate backend storage and the supported commands
that keep project state and test fixtures beneath the checkout's root .forge. -->

# Duplicate backend/.forge cleanup

The Control API and watcher launchers already select the checkout root.
Generic services still accept explicit project roots for multi-project isolation.
No production database or SDK home was merged or replaced during this cleanup.

The old backend/.forge tree was relocated intact to:

```text
.forge/runtime/backups/recovery-backups/backend-forge-2026-10-26T05-57-16.774Z
```

The adjacent `.manifest.json` records all file hashes and the original location.
All 798 files were verified byte for byte after relocation. Both old databases
passed SQLite quick_check and contained no conversations, tickets, agent profiles,
or indexed source files. All 12 old SDK home directories were empty. The old
Control API lock referenced a dead PID. Historical logs, schema copies, backups
and the temporary codemod script remain available in the relocated snapshot.

Retrieval evaluation now opens the checkout root's code index instead of creating
backend/.forge/runtime/wc. Codex gateway tests use disposable SDK homes under
the root .forge/scratch and clean them up after testing.

From backend, run selected tests through the package script:

```sh
npm test -- tests/unit/codex-sdk-gateway.test.js
```

The test runner starts Node at the checkout root and places temporary fixtures
under .forge/scratch/backend-test-tmp. Running raw `node --test` from backend
bypasses this runner; relative paths in other tests can recreate backend/.forge.
Do not symlink backend/.forge to the active .forge tree, because that would let
test defaults write fake SDK agent homes into production runtime storage.
