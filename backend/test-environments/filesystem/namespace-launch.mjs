// Maps the host owner directly to setup root, avoiding a privileged setuid after
// mapping a nonzero principal. A nested single-UID namespace presents that same
// host owner as unprivileged verifier UID 1000, preserving private archive access.
import { fileURLToPath } from "node:url";

// Selects Bubblewrap for setup on hosts that restrict direct unshare. Explicit
// native selection remains available for isolated Linux verification runners.
export function namespaceProcess(nodeArgv, options = {}, environment = process.env) {
  const engine = environment.NODEFORGE_FILESYSTEM_NAMESPACE_ENGINE ?? "bwrap";
  if (engine === "unshare") return { command: "/usr/bin/unshare", argv: namespaceLaunch(nodeArgv, options) };
  if (engine !== "bwrap") throw new Error("VERIFICATION_BLOCKED: namespace engine must be bwrap or unshare");
  return { command: process.execPath, argv: [fileURLToPath(new URL("./namespace-bwrap.mjs", import.meta.url)), ...nodeArgv] };
}

// Builds identical isolation for mapping probes and retained fixture sessions;
// retained sessions additionally tie namespace lifetime to their launcher.
export function namespaceLaunch(nodeArgv, { retained = false } = {}) {
  return ["--user", "--map-auto", "--map-root-user",
    ...(retained ? ["--fork", "--kill-child=TERM"] : []), "--",
    "/usr/bin/unshare", "--mount", "--propagation", "private", "--", process.execPath, ...nodeArgv];
}

// Reinterprets the host owner as verifier UID/GID 1000 in a nested namespace.
// No setuid/setgid/setgroups transition is requested. Setup capabilities exist
// only through mapping; setpriv then drops bounds, inherited and ambient caps
// before Node executes as the nonzero verifier principal.
export function namespaceVerificationCommand(argv, cwd) {
  return ["/usr/bin/unshare", "--user", "--map-user=1000", "--map-group=1000", "--keep-caps", "--",
    "/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs",
    "/usr/bin/env", "--chdir", cwd, ...argv];
}
