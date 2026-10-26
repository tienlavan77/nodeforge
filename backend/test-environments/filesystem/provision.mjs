// Provisions actual ACL, read-only mount and bounded full-filesystem failures
// inside a disposable container. Root performs setup only; Node verification
// executes as UID/GID 1000 with no capabilities and receives the live manifest.
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, closeSync, mkdirSync, openSync, statfsSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

const [root, cwd, ...argv] = process.argv.slice(2);
const testUid = Number(process.env.NODEFORGE_FILESYSTEM_TEST_UID ?? 1000);
const testGid = Number(process.env.NODEFORGE_FILESYSTEM_TEST_GID ?? 1000);
if (process.env.NODEFORGE_FILESYSTEM_CONTAINER !== "1" || process.geteuid() !== 0
  || !Number.isSafeInteger(testUid) || testUid <= 0 || !Number.isSafeInteger(testGid) || testGid <= 0
  || !root || resolve(root) !== root || statfsSync(root).type !== 0x01021994) {
  throw new Error("VERIFICATION_BLOCKED: provisioning requires the dedicated container tmpfs");
}

// Stops immediately on any failed setup command so ordinary directories never
// substitute for mounted filesystems or an ineffective ACL.
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`VERIFICATION_BLOCKED: ${command} exited ${result.status}`);
}

const manifest = {};
const mounted = [];
try {
  for (const kind of ["acl", "readonly", "capacity"]) {
    const directory = join(root, kind);
    mkdirSync(directory);
    if (kind === "capacity") {
      run("mount", ["-t", "tmpfs", "-o", "size=1m,nr_inodes=128,nosuid,nodev,noexec", "tmpfs", directory]);
      mounted.push(directory);
    }
    mkdirSync(join(directory, ".forge/runtime"), { recursive: true });
    writeFileSync(join(directory, "source.txt"), "NodeForge isolated filesystem fixture\n");
    manifest[kind] = { root: directory, sourceFile: "source.txt" };
    chownSync(join(directory, ".forge/runtime"), testUid, testGid);
    if (kind === "acl") {
      const deniedFile = join(directory, "denied.txt");
      writeFileSync(deniedFile, "Disposable ACL evidence\n", { mode: 0o644 });
      run("setfacl", ["-m", `u:${testUid}:---`, deniedFile]);
      run("getfacl", ["--numeric", deniedFile]);
      manifest.acl.deniedFile = "denied.txt";
    } else if (kind === "readonly") {
      run("mount", ["--bind", directory, directory]);
      mounted.push(directory);
      run("mount", ["-o", "remount,bind,ro,nosuid,nodev,noexec", directory]);
    } else {
      // Only this one-MiB tmpfs is filled; no project volume receives filler bytes.
      const fd = openSync(join(directory, "filler"), "wx");
      let full = false;
      try {
        for (let count = 0; count < 512; count++) writeSync(fd, Buffer.alloc(4096));
      } catch (error) {
        if (error.code !== "ENOSPC") throw error;
        full = true;
      } finally { closeSync(fd); }
      if (!full || statfsSync(directory).bfree !== 0) throw new Error("VERIFICATION_BLOCKED: capacity fixture is not full");
    }
  }
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
  mkdirSync(join(root, "work"));
  chownSync(join(root, "work"), testUid, testGid);
  chmodSync(root, 0o755);
  console.log(JSON.stringify({ event: "filesystem-fixtures-ready", manifestPath, uid: testUid, gid: testGid, nodeVersion: process.version, capacityLimitBytes: 1048576 }));
  const result = spawnSync("setpriv", [`--reuid=${testUid}`, `--regid=${testGid}`, "--clear-groups", "--bounding-set=-all",
    "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", process.execPath, ...argv.slice(1)], {
    cwd, stdio: "inherit", env: { ...process.env, NODEFORGE_FILESYSTEM_FIXTURES: manifestPath,
      TMPDIR: join(root, "work"), TMP: join(root, "work"), TEMP: join(root, "work"), PWD: cwd }
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  for (const directory of mounted.reverse()) run("umount", [directory]);
}
