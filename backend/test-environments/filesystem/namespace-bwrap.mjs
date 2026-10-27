// Establishes delegated UID mappings through Bubblewrap's blocked-child
// handshake. Setup runs only after both helpers authorize the mapping; only
// project scratch and verification archives are writable host bindings.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPOSITORY_ROOT } from "../../src/shared/repository-root.js";
import { resolveRuntimePath } from "../../src/infrastructure/filesystem/forge-paths.js";

// Queries the installed system helper for delegated ranges. Mapping helpers
// independently validate delegation before the blocked sandbox can proceed.
function delegatedRange(group = false) {
  const owner = process.env.USER || String(process.getuid());
  if (!/^[a-zA-Z0-9_.-]+$/.test(owner) || owner.startsWith("-")) throw new Error("VERIFICATION_BLOCKED: invalid delegated account name");
  const result = spawnSync("/usr/bin/getsubids", [...(group ? ["-g"] : []), owner], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
  if (result.error) throw result.error;
  const range = result.stdout.trim().split("\n").map(line => line.trim().split(/\s+/))
    .find(fields => Number.isSafeInteger(Number(fields[2])) && Number(fields[2]) > 0 && Number(fields[3]) >= 1000);
  if (result.status !== 0 || !range) throw new Error(`VERIFICATION_BLOCKED: getsubids ${group ? "GID" : "UID"}: ${result.stderr || "no delegated range"}`);
  return range.slice(2, 4);
}

const uidRange = delegatedRange();
const gidRange = delegatedRange(true);
const projectRoot = process.env.NODEFORGE_FILESYSTEM_PROJECT_ROOT || REPOSITORY_ROOT;
const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-user", "--uid", "0", "--gid", "0",
  "--userns-block-fd", "4", "--info-fd", "3", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
  // Linux requires SETFCAP when a nested map includes parent UID zero. This
  // capability belongs only to setup; the verifier drops its entire cap bound.
  ...["SYS_ADMIN", "SETUID", "SETGID", "SETPCAP", "SETFCAP", "CHOWN", "FOWNER"].flatMap(cap => ["--cap-add", `CAP_${cap}`])];
for (const directory of [join(projectRoot, ".forge/scratch"), resolveRuntimePath(projectRoot, ".forge/runtime/ticket-verification/archives")]) {
  if (existsSync(directory)) args.push("--bind", directory, directory);
}
args.push("--", process.execPath, ...process.argv.slice(2));
const child = spawn("/usr/bin/bwrap", args, { stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"] });
let info = "";
let failed = false;

// Stops setup on any mapping or transport failure. A partial identity map must
// never permit fixture provisioning or produce a successful readiness claim.
function fail(error) {
  if (failed) return;
  failed = true;
  console.error("VERIFICATION_BLOCKED: Bubblewrap setup:", error.message);
  clearTimeout(timer);
  child.stdio[3].destroy();
  child.stdio[4].destroy();
  child.kill("SIGKILL");
  process.exitCode = 1;
  // No setup command has started on this path. Closing this handshake owner
  // also releases inherited pipes when a denied helper leaves sandbox waiters.
  process.exit(1);
}
const timer = setTimeout(() => fail(new Error("UID mapping handshake timed out")), 15000);
child.stdio[3].on("error", fail);
child.stdio[3].on("data", chunk => {
  info += chunk;
  if (info.length > 16384) fail(new Error("Unexpected namespace information size"));
});
child.stdio[3].once("end", () => {
  if (failed) return;
  try {
    const pid = JSON.parse(info)["child-pid"];
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Missing sandbox PID");
    for (const [helper, id, range] of [["/usr/bin/newuidmap", process.getuid(), uidRange], ["/usr/bin/newgidmap", process.getgid(), gidRange]]) {
      const result = spawnSync(helper, [String(pid), "0", String(id), "1", "1", ...range], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`${helper}: ${result.stderr.trim()}`);
    }
    clearTimeout(timer);
    child.stdio[4].end("1");
  } catch (error) { fail(error); }
});
child.once("error", fail);
child.stdio[4].on("error", fail);
const stop = () => child.kill("SIGTERM");
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
child.once("close", code => {
  clearTimeout(timer);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  process.exitCode = failed ? 1 : code ?? 1;
});
