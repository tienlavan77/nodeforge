<!-- Records the actual SE handoff for filesystem verification, distinguishing
historical native-error evidence from live fixture availability and specifying
the remaining operator actions without changing ticket or review state. -->

# SE handoff: TICKET-NF-CA-FILESYSTEM

## Namespace follow-up

Current status: **partial, runner live**. Session `fs-ns-9qjU3R` has all three
manifest entries and a responding socket. The complete suite request failed
before Node startup with `spawn unshare EACCES`; no test passed or failed an
assertion. The fixtures are retained. The current machine handoff contains the
real manifest snapshot and failure receipt. Use the new Bubblewrap executable
diagnostic before changing launch flags or restarting this retained session.

The following paragraphs preserve the earlier direct-unshare investigation.

The namespace route is now implemented with explicit start/status/run/stop and
verification wiring; see [namespace runbook](filesystem-namespace-runner.md).
Both uidmap helpers are now installed. The owner's latest probe reports
`unshare failed: Operation not permitted`, without identifying which namespace
operation failed. The new `diagnose` command records each stage separately.
SDK diagnostics show one ancestor UID mapping, NoNewPrivs=1 and CapBnd=0;
single-UID mounts pass while multi-UID helpers cannot write uid_map. Operator
shell diagnostics are still required; repeated start attempts are not advised.
Setup now maps the host owner directly to outer UID 0; verification
maps that same host owner to nested UID/GID 1000. A real single-outer-UID smoke
probe passed: Node UID/GID 1000, CapEff=0, and private archive access without
host permission changes. The ACL file uses a distinct subordinate owner.
This is identity evidence, not full three-fixture acceptance evidence.
The SDK probe is blocked by `newuidmap: write to uid_map failed: Operation not
permitted`. The repaired path needs an independent-shell run. Status remains
partial: no live full manifest, no new ACL evidence and no readiness or
SL-delivery claim. The sections below preserve the earlier handoff evidence;
its one-shot container limitation does not describe the new retained runner.
Current namespace evidence is in
`.forge/scratch/TICKET-NF-CA-FILESYSTEM-se/namespace-handoff.json`.

## 1. Status: partial

The readonly and capacity cases have historical native-error evidence. A full
live fixture set is unavailable. ACL has not been executed on this host.
There is no retained fixture environment available for SL/Coder verification.
This handoff is a report of partial preparation, not a readiness declaration.

The fresh runner check exits 1 with `VERIFICATION_BLOCKED` and `ENOENT` for
Docker. Podman is also absent. The host has one usable UID mapping; the previous
single-UID namespace cannot establish the distinct-owner, named-user ACL case.

## 2. Actual manifest

`NODEFORGE_FILESYSTEM_FIXTURES` has no verified, usable full-set value to hand off.
Its actual manifest path, checksum and content are **unavailable**, recorded as
null in the machine-readable handoff. No placeholder JSON has been published as
a working manifest. The required entries `acl`, `readonly`, `capacity` are all
marked unavailable for live reuse; readonly/capacity receipts remain historical.

The old roots below no longer exist and must not be configured in verification:

```text
/home/data/sites/nodeforge/.forge/scratch/filesystem-local-KUDwRJ/readonly
/home/data/sites/nodeforge/.forge/scratch/filesystem-local-KUDwRJ/capacity
```

## 3. Runner, user and environment propagation

Historical mount checks ran as effective UID/GID 1000 with
`CapEff=0000000000000000`. The receipt preserves independently emitted credential
diagnostics from the existing TAP log; it does not claim a currently live worker.

The default Node ticket-verification executor copies its process environment to
the child. If a real, readable manifest is supplied to that verifier process as
`NODEFORGE_FILESYSTEM_FIXTURES`, the filesystem check follows the native path.
Exporting the variable in an unrelated shell does not configure an existing API.
The verifier must run in the same mount namespace as the supplied fixtures.

Without that variable, the prepared executor routes the environment test into
`backend/scripts/verify-filesystem-environment.mjs`. The container entrypoint
sets the variable on its actual unprivileged Node test child. That route has not
run successfully here; an already running API has not been restarted to load it.

## 4. Commands, results and receipts

Current complete-run command, executed from `/home/data/sites/nodeforge`:

```sh
/opt/node-26/bin/node backend/scripts/verify-filesystem-environment.mjs
```

Result: exit 1, engine/image unavailable; no fixture set was created.

The historical probe script invoked the two-case check with:

```sh
unshare --user --map-user=1000 --map-group=1000 -- \
  /opt/node-26/bin/node --test --test-reporter=tap \
  '--test-name-pattern=real filesystem environment: (readonly|capacity)' \
  backend/tests/integration/project-filesystem-environment.test.js
```

That command ran inside a previously provisioned private mount namespace, with
the live two-entry manifest and TMPDIR set by the probe script. It cannot be
repeated alone now. The command is documented from the script/session; the old
log did not itself record an original argv receipt.

Result: 2 tests, 2 passes, 0 failures/skips. Readonly generated native `EROFS` and
capacity generated native `ENOSPC` on a 1 MiB tmpfs. Each case covered backend
preflight/Add, a subsequent native operation and source preservation. ACL has
no native-error receipt. No complete three-case acceptance pass is asserted.

Absolute receipt paths and SHA-256 values are in:

```text
/home/data/sites/nodeforge/.forge/scratch/TICKET-NF-CA-FILESYSTEM-se/handoff.json
/home/data/sites/nodeforge/.forge/scratch/TICKET-NF-CA-FILESYSTEM-se/SHA256SUMS
```

## 5. Lifetime and remaining operator actions

The old private namespace was unmounted and removed before the new retention
request. None of its fixtures survives or can be recovered by restarting Forge.
The prepared container launcher is one-shot: it unmounts fixtures and removes
its container on exit. It does **not** meet the new keep-until-review requirement.

An operator must provide a separate disposable Linux runner with a working
rootful container engine or equivalent mount/ACL privileges. Do not provision
these denials against the production project volume. On that runner, build with:

```sh
docker build -t nodeforge-filesystem-fixtures:node26 backend/test-environments/filesystem
```

Before declaring ready, provision a retained namespace/container with all three
fixtures, keep its supervisor independent of Forge, and execute verification
inside that namespace as a nonzero UID with CapEff zero. Its startup must emit
the actual manifest content, absolute path, SHA-256 and container/namespace ID.
Configure the actual Node verifier there with that manifest, capture all three
native-error receipts, and retain the environment through review.

An API-only restart may reuse fixtures only while the independent supervisor
and mounts are still alive. A container/runner restart requires reprovisioning,
a new manifest checksum and fresh fixture checks; stale receipts alone are not
readiness proof. Cleanup must occur only after verification/review completion:
stop the dedicated supervisor, unmount only its fixture mounts and remove its
owned temporary directories. No automatic expiry is currently configured.

The prepared one-shot CI workflow can establish a complete three-case run once
published and executed, but by itself does not provide retained live fixtures.
Neither publication nor execution has been performed. Ticket state and finding
decisions remain untouched; SL receipt of this report has not been confirmed.
