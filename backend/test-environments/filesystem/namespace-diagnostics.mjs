// Separates host identity, user mapping and mount-namespace failures so an
// operator can resolve a concrete permission gate without repeated flag changes.
// Probes create no fixtures and change no host mount, ownership or policy.
import { spawnSync } from "node:child_process";
import { namespaceProcess } from "./namespace-launch.mjs";

// Records kernel-exposed process credentials and confinement in the executing
// namespace; unavailable diagnostics remain explicit instead of aborting capture.
export const NAMESPACE_IDENTITY_PROBE = `
const fs = require('node:fs');
const values = {};
for (const name of ['status', 'uid_map', 'gid_map', 'setgroups', 'attr/current']) {
  try {
    let value = fs.readFileSync('/proc/self/' + name, 'utf8');
    if (name === 'status') value = value.split(String.fromCharCode(10)).filter(line => /^(Uid|Gid|Groups|CapEff|CapBnd|NoNewPrivs|Seccomp):/.test(line)).join(String.fromCharCode(10));
    values[name] = value.trim();
  } catch (error) { values[name] = { unavailable: error.code, message: error.message }; }
}
console.log(JSON.stringify({ uid: process.geteuid(), gid: process.getegid(), values }));
`;

// Runs bounded mapping-only and mount probes separately. The split probe emits
// credentials before attempting its mount namespace, localizing an EPERM error
// to the exact stage; all temporary namespaces disappear when each probe exits.
export function namespaceDiagnostics() {
  const node = process.execPath;
  const splitProbe = `${NAMESPACE_IDENTITY_PROBE}
const cp = require('node:child_process');
console.log(JSON.stringify({ stage: 'mount-namespace', event: 'starting' }));
const result = cp.spawnSync('unshare', ['--mount', '--propagation', 'private', '--', process.execPath, '-e', ${JSON.stringify(NAMESPACE_IDENTITY_PROBE)}], { encoding: 'utf8', timeout: 10000 });
console.log(result.stdout || ''); console.error(result.stderr || '');
if (result.error) console.error(result.error.message);
console.log(JSON.stringify({ stage: 'mount-namespace', exitCode: result.status, error: result.error?.message ?? null }));
process.exitCode = result.status ?? 1;`;
  const probes = [
    { stage: "host-identity", command: node, argv: ["-e", NAMESPACE_IDENTITY_PROBE] },
    { stage: "single-uid-user-and-mount", command: "unshare", argv: ["--user", "--map-root-user", "--", node, "-e", splitProbe] },
    { stage: "multi-uid-user-then-mount", command: "unshare", argv: ["--user", "--map-auto", "--map-root-user", "--", node, "-e", splitProbe] },
    { stage: "multi-uid-combined-user-and-mount", command: "unshare", argv: ["--user", "--map-auto", "--map-root-user", "--mount", "--propagation", "private", "--", node, "-e", NAMESPACE_IDENTITY_PROBE] }
  ];
  const executionProbe = `${NAMESPACE_IDENTITY_PROBE}
const cp = require('node:child_process');
for (const executable of ['unshare', '/usr/bin/unshare', 'setpriv', '/usr/bin/setpriv']) {
  const result = cp.spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 });
  console.log(JSON.stringify({ stage: 'verification-executable', executable, exitCode: result.status, error: result.error ? { code: result.error.code, message: result.error.message } : null, stdout: result.stdout, stderr: result.stderr }));
  if (result.error || result.status !== 0) process.exitCode = 1;
}`;
  probes.push({ stage: "namespace-verification-executables", ...namespaceProcess(["-e", executionProbe]) });
  return {
    purpose: "Stage-specific native namespace diagnostics; not filesystem acceptance or readiness evidence",
    timestamp: new Date().toISOString(),
    probes: probes.map(probe => {
      const result = spawnSync(probe.command, probe.argv, { encoding: "utf8", timeout: 12000, killSignal: "SIGKILL" });
      return { ...probe, exitCode: result.status ?? 1, error: result.error?.message ?? null, stdout: result.stdout, stderr: result.stderr };
    })
  };
}
