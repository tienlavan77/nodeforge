<!-- Provides the SE-to-Coder handoff for real filesystem denial infrastructure.
It separates observed host evidence from container coverage that still requires
a capable runner, preserving the ticket checkpoint and review authority. -->

# Filesystem verification infrastructure

Ticket: `TICKET-NF-CA-FILESYSTEM`; observed checkpoint: `coding`, version 98.
No ticket state, review decision, commit or queue entry was modified by SE.

## Current evidence

The current host runs as UID 1000 without effective capabilities. It supports
private user/mount namespaces and bounded tmpfs mounts. Two real acceptance cases
passed as UID 1000 with no effective capabilities: read-only produced `EROFS`;
the full 1 MiB tmpfs produced `ENOSPC`. Both exercised backend preflight, Add,
subsequent native operations and source preservation. Evidence is in
`.forge/scratch/filesystem-local-evidence.log`. These fixtures were unmounted
and their empty host directories removed after the run.

ACL coverage is **not established**. This host has only a single usable UID map,
no subordinate-ID mapping helpers, and no Docker/Podman executable. Its runner
cannot currently provide a differently owned ACL file for the unprivileged
principal. The full container run correctly reports `VERIFICATION_BLOCKED`.
The two local passes do not close REV-1 or establish final ticket verification.

## Dedicated runner

On a disposable Linux CI machine with a working rootful Docker engine and the
same project dependencies installed:

```sh
docker build -t nodeforge-filesystem-fixtures:node26 backend/test-environments/filesystem
node backend/scripts/verify-filesystem-environment.mjs
```

The build context contains only the fixture infrastructure. The container has no
network and a read-only project bind. A 32 MiB tmpfs contains all fixture data;
capacity exhaustion is limited to a separate 1 MiB tmpfs. Setup runs as container
root, then `setpriv` drops to a nonzero UID matching the host runner and removes
all capabilities before executing Node tests. Rootless engine UID translation
has not been validated; use the disposable hosted workflow for this coverage.

The ACL file is root-owned, mode-readable, and has a named-user ACL denying the
test principal. Read-only uses a real remounted bind. Capacity is filled until
the kernel returns `ENOSPC` and statfs reports no free blocks. The entrypoint
writes `{acl, readonly, capacity}` to a manifest and exports
`NODEFORGE_FILESYSTEM_FIXTURES` to the exact Node child running the test suite.
The manifest is valid only while that container is running; do not export its
path into a different host process or reuse it after cleanup.

The manual GitHub Actions workflow `Filesystem verification` performs the build
and narrow acceptance run, recording the checked-out commit and uploading output.
It has been prepared locally; no workflow was published or triggered from SE.

## Node verification wiring and handoff

The default ticket-verification executor detects the filesystem environment test
and routes its existing argument vector into the container launcher. A supplied
`NODEFORGE_FILESYSTEM_FIXTURES` keeps the native path for pre-provisioned runners.
Unrelated commands are unchanged. This applies to final checks and focused/review
checks using the same default executor. A materialized verification archive may
be writable inside the container; the live checkout remains read-only and Node
continues checking the source hashes after execution.

Runner infrastructure participates in retry identity for the ticket's filesystem
test plan, allowing a bounded retry after an infrastructure repair. A running
Control API must load the updated verifier code before using this wiring; SE did
not restart the API from its own session or alter its process environment.

SL/Coder should continue the existing checkpoint on the capable runner, run the
real environment suite, repair any failure, and use the normal ticket commit and
verification flow. Reviewer then assesses REV-1 against the exact-revision output.
No final approval or commit is inferred from the partial local checks. Fixtures
are unmounted on exit and the container is removed, with cancellation forwarded
to the engine and cleanup restricted to the unique container created by the run.
