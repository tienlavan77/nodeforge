<!-- Preserves the sandbox design amendment formerly appended to the lifecycle document so isolation requirements remain readable separately while original lifecycle bytes retain their pre-move identity. -->
## Ordinary verification write sandbox design

This section is the SE handoff for the multi-project verification isolation work.
It does not approve implementation, change the verification contract, or replace
an Architecture Plan approval.

### Problem and boundary

`backend/src/modules/supervisor/ticket-verification-command.js:L12-L47`
currently uses direct `spawn` for `environment: "project"` and for an omitted
environment. `ticket-verification-materialization.js` records ticket and project
environment hashes after execution, but those checks detect mutation rather than
prevent a child process from reaching another project or the global catalog.

The new boundary applies to ordinary focused, final, regression and Reviewer
verification. `filesystem_namespace` remains a separate fixture runner and must
not be routed through this adapter. Coding processes, browser verification,
and the public environment enum remain outside this change.

### Required execution model

Wrap each ordinary command in a short-lived, per-command Bubblewrap namespace.
The adapter is Node-owned: agents provide no mount flags, socket paths, host
paths, or environment overrides. Node canonicalizes `projectRoot`, archive cwd,
temp directory and output paths before constructing the command.

The namespace must:

1. expose only the minimum read-only system paths required by Node and the
   command, plus private `/dev`, `/proc` and a temporary `/tmp`;
2. bind the current project/archive and required dependencies read-only;
3. mask the project `.forge` tree, global catalog, host home, control sockets,
   credentials, and every other project root;
4. bind writable access only to the current archive's `.forge-tmp`, runtime and
   explicitly declared output directories, each created for this job;
5. set `cwd`, `TMPDIR`, `TMP` and `TEMP` to the current archive/job scope; and
6. apply the same restrictions to descendants, with `--die-with-parent`, a new
   session, dropped capabilities, and no inherited writable descriptors.

Do not bind the parent directory containing multiple projects. Do not make
`projectRoot/node_modules` writable merely to preserve a dependency symlink. If
a dependency link cannot resolve under read-only mounts, change the materialized
archive/mount mapping rather than widening write access.

### Multi-project isolation rules

A request for Project A may reference only A's canonical identity and the
archive/temp/runtime belonging to that request. No process-global mount cache may
reuse A's writable paths for Project B. Concurrent A/B commands need separate
namespace construction, temp/output paths and receipts. A descendant using an
absolute path, `..`, symlink, rename, unlink, hard link or a child process must
not read or write B, the catalog, source, or read-only dependencies.

The existing `project-lifecycle.js` starts independent runtimes for canonical
roots in one process, while `multi-project-lifecycle.md` keeps the global catalog
outside per-project runtime directories. The sandbox must preserve those
boundaries; it is not sufficient to hash only A's archive after the command.

### Fail-closed and receipt contract

Both `environment: "project"` and omitted environment must use the sandbox. A
missing Bubblewrap binary, unsupported namespace policy, invalid canonical path,
mount failure, writable-path escape, timeout or aborted startup fails before the
user command runs. There is no ordinary-verification fallback to host `spawn`.
Use explicit infrastructure/scope error codes, log the caught error, tear down
owned processes and mount state, and retain a failed verification receipt.

Keep all existing `assertTicketSource`, `assertEnvironment`, archive checks,
output hashing, baseline attribution and Reviewer integrity checks. Add sandbox
engine/status and project/archive binding only if the receipt schema requires
it; a ready sandbox is never a passing test. Do not expose secrets or private
host paths in receipts or logs.

Landlock is optional defense-in-depth for a later revision. It does not replace
mount masking because the first objective is to hide other project roots,
catalogs and sockets. If Landlock is added, unsupported setup must also fail
closed rather than silently weakening Bubblewrap policy.

### Implementation and verification handoff

Likely implementation points are `ticket-verification-command.js`, a new
supervisor adapter/policy module, and tests around command receipts and
materialization. `ticket-focused-check.js`,
`ticket-verification-regression.js`, and `review-verification-service.js` must
continue passing the same archive/project identity and preserve current
acceptance semantics. Keep every changed file within the 250 `code_lines` rule,
add purpose comments for new files/functions, and use glossary vocabulary.

Acceptance evidence must include:

- unit coverage proving ordinary execution never calls host `spawn` when the
  sandbox is unavailable;
- two real sibling projects running concurrently, with attempted cross-project
  read/write, catalog access, symlink escape and descendant-process escape;
- read-only source/dependencies, masked `.forge`, scoped temp/runtime/output and
  independent receipts;
- focused, final, regression, baseline and Reviewer verification receipts with
  unchanged integrity/attribution behavior;
- timeout, abort, malformed path, Bubblewrap exit and cleanup tests; and
- compatibility coverage proving `filesystem_namespace` still uses its existing
  runner.

Production rollout requires an owner decision for host prerequisites, network
policy and tests/builds that currently write in the source tree. A unit test or
runner receipt alone is not production acceptance. If a host lacks Bubblewrap or
namespace support, stop rollout there and use an approved compatible runner; do
not install helpers, widen directory permissions, or expose the global catalog as
an unsandboxed workaround.
