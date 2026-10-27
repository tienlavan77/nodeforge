<!-- Records reusable namespace evidence and the exact remaining SL handoff,
without treating workspace checks as commit-bound ticket acceptance. -->

# SE handoff: TICKET-NF-CA-FILESYSTEM

## Current retry and delivery repair

The fresh workspace run passed all seven tests with zero skips. Receipt:
`.forge/scratch/fs-ns-OCD75M/verification-8122e4bf-ac28-472a-bfa4-b81356427911.json`.
The retained socket still responds. This is infrastructure evidence, not final
commit-bound ticket acceptance or REV-1 resolution.

The earlier Owner response was recorded and queued for SL, but the checkpoint
then stopped at 11:26:42 with `technical_reconciliation_no_progress`: the issued
`owner_inputs` and `authority_context` indexes returned ENOENT. The files exist
under the grouped `recovery/blocker-context` directory. `readForIndex` bypassed
runtime path mapping while context writes applied it. The source fix now maps
index reads through `runtimeStoragePath` while preserving logical paths and
checksum grants. Seven real persisted indexes and all their listed parts were
read and checksum-verified through the repaired FileService.

Next delivery should reuse the recorded answer and retained checkpoint after
the API loads this read-path fix, then resume SL through the supported recovery
flow. Do not resubmit the same answered request or manually edit checkpoint
state. The current process has not been restarted by this retry. The old queued
receipt proves submission, not successful SL consumption. Keep the runner alive.

Infrastructure status: **verified; API reloaded; SL handoff queued** (2026-10-26).
The retained namespace runner is live. Seven real filesystem tests passed,
14 focused runner unit tests passed, and targeted namespace setup lint passed.
REV-1 remains open pending ticket commit-bound verification and independent review.

## Live environment

- Session: `.forge/scratch/fs-ns-OCD75M` (server PID 506847).
- Socket: `/home/data/sites/nodeforge/.forge/scratch/fs-ns-OCD75M/runner.sock`.
- Manifest: `/home/data/sites/nodeforge/.forge/scratch/fs-ns-OCD75M/fixtures/manifest.json`.
- Manifest SHA256: `1722ca6af69091cd15bbeeab5d4a632211cc040a5c4ce777d050709663f01f8d`.
- Test SHA256: `ef2c0eab44c85927e20fadaac83536694480ab0825d93cbf4f31adfd5bd32051`.

The manifest has `acl`, `readonly`, and `capacity` roots with readable
`source.txt`; ACL additionally supplies `denied.txt` with a real ACL denial.
Mounts are private to the retained runner. Do not pass the manifest path to a
host process expecting to see the mounted fixtures. Pass the socket instead;
the server supplies the manifest variable to its actual unprivileged child.

## Executed evidence

All seven tests in `project-filesystem-environment.test.js` passed, zero failed.
They assert UID != 0 and CapEff=0, actual EACCES/EROFS/ENOSPC (or EDQUOT),
preflight and Add behavior, subsequent native operations, and source preservation.

Receipt: `.forge/scratch/fs-ns-OCD75M/verification-5ecdf59e-3758-4a06-b204-1dca0371edcf.json`.
TAP log: `.forge/scratch/fs-ns-OCD75M/acceptance.log`.
The receipt binds exact argv/cwd, timestamps, manifest and test checksums.
Machine handoff and infrastructure hashes:
`.forge/scratch/TICKET-NF-CA-FILESYSTEM-se-handoff.json`.

```sh
export NODEFORGE_FILESYSTEM_NAMESPACE_SOCKET=/home/data/sites/nodeforge/.forge/scratch/fs-ns-OCD75M/runner.sock
node backend/scripts/verify-filesystem-namespace.mjs status
node backend/scripts/verify-filesystem-namespace.mjs run
```

## API and SL handoff

`config/.env` contains the socket setting. The operator restarted Control API
(PID 511158), which is now listening on port 3100. Do not start a second API.
The executor adapter forwards exact Node arguments and archive cwd to this
runner; unrelated verification commands retain their usual execution path.

The authenticated ticket `blocker-response` operation returned HTTP 200,
`status: recorded` and `handoff: queued`, resuming stage `sprint_leader`.
Input receipt: `BLOCKER-INPUT-14fc3e88-5fee-4eb4-9301-8de59abadaef`.
Full response: `.forge/scratch/fs-ns-OCD75M/sl-response.result.json`.
SL then returns Coder to its retained checkpoint
for focused checks, repairs if required, commit-bound verification, and Reviewer.
No approval, RUN entitlement, finding disposition, or completion was changed.

Keep the runner alive through verification and review. When deliberately stopped,
its private mounts disappear; receipts remain. Remove or replace the socket
setting before subsequent filesystem verification. The old configuration and
reports are backed up under the session's `handoff-backup/` directory.

## Diagnosed failures

The original spawn EACCES occurred while libuv opened `/dev/null`, not while
checking the unshare executable. Private `/dev` and `/proc` mounts fix that.
The next nested-map EPERM required setup CAP_SETFCAP for parent UID zero.
All capabilities are dropped before the Node test process executes.
The old failed session remains separate; its evidence was preserved.
