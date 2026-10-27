<!-- Explains how operators supply the missing host UID mapping infrastructure
and retain isolated native-error fixtures through Coder verification and review.
Separates implemented commands from execution evidence and readiness claims. -->

# Retained filesystem namespace runner

## Agent-requested runner lifecycle

Coder requests fixtures through the existing focused verification tool:

```json
{"type":"test","command":"node --test backend/tests/integration/project-filesystem-environment.test.js","environment":"filesystem_namespace"}
```

Reviewer supplies `"environment":"filesystem_namespace"` in an existing
`verification_requests` entry alongside its finding, criterion, test paths,
artifact, commit, and source revision. Node returns the evidence to Reviewer;
ordinary verification does not require SL or AM dispatch.

The environment enum is shared by Coder and Reviewer. Omission preserves the
existing compatibility path; explicit `project` uses native project execution.
An explicit namespace request works with other focused Node test files too.
Successful setup alone never establishes test acceptance.

Node checks project identity and socket health before reuse, starts a session if
none is available, and serializes concurrent requests for that project. A Coder
request is retained in the execution context for final ticket test verification.
Source archives, dependency snapshots, commits, and finding authority stay bound
to their existing verification contracts. Receipts include `runtime_environment`
with the socket, manifest checksum, server PID, and namespace receipt path.

Node-owned sessions stop after five idle minutes or normal API process exit.
The next request starts another session when necessary. Operator/SE sessions
are reused without acquiring cleanup ownership. Stop cancels a queued request
or closes an active request socket, causing the server to stop that verifier.
Startup failures retain `setup.log`; test receipts survive session cleanup.
Host prerequisites must already exist; Node never installs packages or changes
subordinate-ID policy to satisfy an agent request.

The on-demand path was exercised without a configured socket: Node started
session `fs-ns-mr9lpI`, passed all seven real filesystem tests, and cleaned up
the owned runner on process exit. The outer receipt is
`.forge/scratch/filesystem-managed-verification.receipt.json`.
This verifies the new source path; the running Control API still needs a safe
reload to expose the new agent schema and lifecycle code.

## Current result (2026-10-26)

Session `fs-ns-OCD75M` is live. All seven real filesystem tests passed through
its socket, including native ACL EACCES, readonly EROFS, and capacity ENOSPC.
The Node test process uses UID/GID 1000 and zero effective capabilities.
See [the current SE handoff](TICKET-NF-CA-FILESYSTEM-se-handoff.md) for exact
manifest, source identities, receipt, and API reload status. Workspace evidence
is not final ticket commit-bound acceptance and does not close REV-1.

The original spawn EACCES came from opening `/dev/null`, confirmed by strace.
The Bubblewrap root binding now adds private `/dev` and `/proc` mounts.
Nested UID mapping also requires CAP_SETFCAP in setup because its map includes
parent UID zero. The verifier drops its entire capability bound before Node.
No host AppArmor policy, sysctl, or project ownership change was needed.

Earlier sessions `fs-ns-9qjU3R` and `fs-ns-RPRldq` are historical evidence;
do not configure their sockets as the current verifier. The old runbook is
retained in `.forge/scratch/fs-ns-OCD75M/handoff-backup/`.

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

Do not merely unpack or copy the helper executables into the project: their
privileged installation and subordinate-ID authorization must work together.
The runner queries existing delegated ranges and validates them with the helpers.
It does not edit subordinate-ID configuration.
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
