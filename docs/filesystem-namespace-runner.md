<!-- Explains how operators supply the missing host UID mapping infrastructure
and retain isolated native-error fixtures through Coder verification and review.
Separates implemented commands from execution evidence and readiness claims. -->

# Retained filesystem namespace runner

## Current result

Latest repair: Bubblewrap setup and its `namespaceProcess` export are restored
in the current workspace. Verifier launch now uses absolute `/usr/bin/unshare`,
`/usr/bin/setpriv` and `/usr/bin/env` paths. A real single-UID setup invoking
the production verifier command with an unusable PATH passed: Node UID/GID
1000, CapEff=0, and private mode-0700 archive access. This removes PATH lookup
from the earlier spawn EACCES investigation; it does not prove the original
EACCES cause or full Bubblewrap acceptance. Fourteen narrow regression tests pass.
The actual current Bubblewrap probe exits promptly with uid_map write denied
inside SDK; no fixture has been allocated by this repair.
The old session below is historical: its socket has disappeared. Status remains
partial, with no current confirmed live fixture. After these code checks the
next host-shell operation is `start`, which repeats the actual setup probe.
Do not run the retired socket path or treat old session metadata as live.

Status: **partial**. Bubblewrap runner `fs-ns-9qjU3R` is live and its owner-only
socket responds. Its manifest contains acl, readonly and capacity. The first
complete suite request failed before Node started: `spawn unshare EACCES`.
The actual receipt is `verification-157c2914-07f7-4cdc-8074-0298f1f98c2d.json`
in that session directory. Fixture setup is not acceptance evidence. Keep the
runner alive while investigating executable access inside Bubblewrap.
The `diagnose` command now includes `bwrap-verification-executables` to compare
PATH-based and absolute-path execution of unshare and setpriv in that profile.

Earlier direct-unshare investigation follows for context; it does not describe
the current Bubblewrap runner's startup result. The operator installed uidmap.
Their latest probe failed with `unshare: unshare failed: Operation not permitted`.
That command contains separate user and mount namespace operations, so the old
receipt alone cannot identify the denied stage. Use `diagnose` before another
startup attempt. SDK diagnostics confirm this execution shell itself has only
one mapped UID, NoNewPrivs=1 and CapBnd=0: its single-UID mount probe passes,
but both multi-UID probes fail at the helper's uid_map write. This SDK evidence
does not establish the independent operator shell's confinement or mount policy.
The runner now maps the host owner directly to setup UID 0 instead of requesting
a privileged UID switch after mapping that owner to UID 1000. Verification uses
a nested user namespace mapping the same host owner to UID/GID 1000, then drops
capability bounds, inherited and ambient capabilities before exec of Node.
A real single-outer-UID namespace probe passed: actual Node UID/GID 1000,
CapEff=0, and access to a private mode-0700 archive with a mode-0600 source.
This validates identity handling, not the full three-fixture acceptance suite.
The complete multi-UID path still needs an independent-shell run. Inside the SDK,
the actual probe is blocked earlier: `newuidmap: write to uid_map failed:
Operation not permitted`. Reinstalling uidmap is not the next step.
There is still no passing ACL acceptance receipt.
The historical EROFS/ENOSPC receipts remain historical.

The runner uses Linux namespaces through Bubblewrap by default, with explicit
`NODEFORGE_FILESYSTEM_NAMESPACE_ENGINE=unshare` available. It requires util-linux, acl,
working `newuidmap`/`newgidmap`, configured subordinate UID/GID ranges, and a
kernel/security policy permitting multi-UID user namespaces and private mounts.
This implementation deliberately requires host UID/GID 1000. That host owner
is setup UID/GID 0 in the outer namespace and verifier UID/GID 1000 in the
nested namespace. The ACL file belongs to a distinct subordinate principal
(outer UID/GID 1000); its named-user ACL denies outer UID 0, which is the nested
verifier UID 1000. Ordinary file mode bits remain readable. No UID/GID switching
or supplementary-group changes are needed. The Node child has CapEff=0.

## Operator prerequisite

The helpers are now installed on this host. On another Debian/Ubuntu runner,
an administrator can install the helper package:

```sh
sudo apt-get install uidmap
```

System installation is outside this SDK session's project-only write scope.
Do not merely unpack or copy the helper executables into the project: their
privileged installation and subordinate-ID authorization must work together.
No subordinate-ID configuration has been read or changed by this task.
Existing ranges reported by the operator still need an actual successful probe.
If helper execution is denied by the SDK sandbox's privilege policy, run these
commands from an independent operator shell with the same project user.
If the kernel blocks the mappings or mounts, use an isolated compatible Linux
runner; Docker remains an alternative, not a prerequisite for this runner.

## Start and verify

From the independent host shell in `/home/data/sites/nodeforge`, diagnose first:

```sh
/opt/node-26/bin/node backend/scripts/verify-filesystem-namespace.mjs diagnose
```

This creates `.forge/scratch/filesystem-namespace-diagnostics.receipt.json` with
host process identity, namespace maps, capabilities, NoNewPrivs, seccomp mode
and confinement label. It probes single-UID setup, multi-UID setup then mount,
and combined user/mount setup separately. Credentials emitted before the mount
attempt distinguish user-mapping failure from mount failure. No fixtures or
host policy changes are made. A nonzero exit means at least one probe failed;
preserve the receipt for analysis before retrying start. Restrictive ancestor
UID mappings cannot be expanded merely by installing helpers inside that shell.

Once the diagnosed gates are resolved, run:

```sh
/opt/node-26/bin/node backend/scripts/verify-filesystem-namespace.mjs probe
```

This records the exact command, exit status and mapping diagnostics in
`.forge/scratch/filesystem-namespace-probe.receipt.json`.
Successful mapping alone does not prove mount or ACL acceptance.

In an independent terminal kept alive through review:

```sh
/opt/node-26/bin/node backend/scripts/verify-filesystem-namespace.mjs start
```

Start repeats the mapping probe, allocates a unique `fs-ns-*` directory, mounts
a 32 MiB private tmpfs, and mounts a separate 1 MiB capacity tmpfs. Filler bytes
go only to that bounded tmpfs. The readonly fixture is a real remounted bind.
No project file ownership, ACL or mount options are changed.
The session directory is owner-only mode 0700 and its command socket is mode
0600. Setup and verification retain the host owner's access to private archives.

Startup emits `socketPath`, manifest content, absolute `manifestPath`, checksum,
actual UID/GID maps and ACL output. These are also stored in `session.json`.
Its status is `provisioned`, not acceptance-ready. If setup fails, do not export
the emitted preliminary socket path or reuse a stale session.

In the verifier shell, copy the actual emitted socket path:

```sh
export NODEFORGE_FILESYSTEM_NAMESPACE_SOCKET='/absolute/emitted/fs-ns-session/runner.sock'
unset NODEFORGE_FILESYSTEM_FIXTURES
/opt/node-26/bin/node backend/scripts/verify-filesystem-namespace.mjs status
/opt/node-26/bin/node backend/scripts/verify-filesystem-namespace.mjs run
```

The path above is illustrative, not a supplied live fixture. `run` defaults to
the complete seven-test filesystem environment suite, including all three native
denials. It streams TAP and writes `verification-*.json` in the session directory
with exact argv/cwd, timestamps, manifest checksum, test-file checksum, output
and exit status. The integration tests independently assert effective UID != 0
and CapEff=0, require native EACCES/EROFS/ENOSPC (or allowed EDQUOT), and exercise
preflight, Add, a subsequent native operation, and source preservation.
There is no name filter, fabricated error or skipped denial case.

## Node verification wiring

Set `NODEFORGE_FILESYSTEM_NAMESPACE_SOCKET` on the actual Node verification
executor process before it starts. Exporting it in an unrelated shell does not
configure a running API. Use the existing service's environment configuration;
do not start a second API. No API restart is performed automatically here.

The default ticket executor's filesystem command adapter recognizes this variable
and forwards the original Node argv and archive cwd to this retained runner.
Other checks keep their usual execution path. Namespace requests take priority
over the container fallback; an explicitly supplied filesystem manifest retains
the existing direct execution path, so remove any stale manifest variable.
The namespace server sets `NODEFORGE_FILESYSTEM_FIXTURES` directly on its actual
unprivileged Node child. Do not export the namespace-private manifest path to a
host Node process: that process cannot see the private mounts.

An explicit archived command can be sent as:

```sh
/opt/node-26/bin/node backend/scripts/verify-filesystem-namespace.mjs run \
  --cwd '/absolute/project/verification/archive' -- \
  /opt/node-26/bin/node --test --test-reporter=tap \
  backend/tests/integration/project-filesystem-environment.test.js
```

Use the actual verifier archive. Run serially; concurrent verification and stop
during verification are rejected. A lost client connection terminates its Node
verification process. Nothing here changes ticket or finding state or sends SL
a message. Reviewer must assess the real receipt at the intended source version.

## Retention and cleanup

Successful or failed tests leave the namespace and fixtures alive. API-only
restart can reuse the socket while the independent runner stays alive. Shell,
runner or host termination loses the private mounts; restart `start`, obtain the
new socket/manifest and rerun the full suite. Receipt files survive, mounts do
not. Session startup does not resurrect old paths or old readiness claims.

After verification and review finish, from the configured verifier shell:

```sh
/opt/node-26/bin/node backend/scripts/verify-filesystem-namespace.mjs stop
```

Stop unmounts only the session's private fixtures and exits. The host launcher
removes the empty fixture mountpoint. Session metadata and receipts are retained
for audit; `stopped.json` records shutdown. There is no automatic expiry, and no
live fixture was created or cleaned by the current blocked attempt.
