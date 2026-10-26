// Builds retained, bounded Linux fixtures for filesystem admission verification.
// Only private tmpfs mounts are filled or permissioned; the caller must already
// have established a multi-UID user namespace and a private mount namespace.
import { spawnSync } from "node:child_process";
import { chownSync, closeSync, mkdirSync, openSync, readFileSync, statfsSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// Treats failed provisioning commands as unavailable infrastructure rather than
// substituting ordinary directories for the required native denial conditions.
export function namespaceCommand(command, argv) {
  const result = spawnSync(command, argv, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

// Establishes a distinct fixture owner and verifier principal before touching
// mounts. The real ACL must deny a file that ordinary mode bits allow reading.
export function provisionNamespaceFixtures(root) {
  if (process.geteuid() !== 0) throw new Error("VERIFICATION_BLOCKED: namespace setup requires mapped UID 0");
  for (const name of ["uid_map", "gid_map"]) {
    const ranges = readFileSync(`/proc/self/${name}`, "utf8").trim().split("\n")
      .map(line => line.trim().split(/\s+/).map(Number));
    if (!ranges.some(([start, , count]) => start <= 0 && start + count > 0)
      || !ranges.some(([start, , count]) => start <= 1000 && start + count > 1000)) {
      throw new Error(`VERIFICATION_BLOCKED: ${name} must map both 0 and 1000`);
    }
  }
  const mounted = [];
  const manifest = {};
  // Releases private mounts only when the retained runner is explicitly stopped
  // or setup fails; ordinary verification completion keeps fixtures available.
  const cleanup = () => {
    for (const directory of [...mounted].reverse()) namespaceCommand("umount", [directory]);
  };
  try {
    namespaceCommand("mount", ["-t", "tmpfs", "-o", "size=32m,nr_inodes=2048,nosuid,nodev,mode=0755", "tmpfs", root]);
    mounted.push(root);
    for (const kind of ["acl", "readonly", "capacity"]) {
      const directory = join(root, kind);
      mkdirSync(directory);
      if (kind === "capacity") {
        namespaceCommand("mount", ["-t", "tmpfs", "-o", "size=1m,nr_inodes=128,nosuid,nodev,noexec,mode=0755", "tmpfs", directory]);
        mounted.push(directory);
      }
      mkdirSync(join(directory, ".forge/runtime"), { recursive: true });
      chownSync(join(directory, ".forge/runtime"), 0, 0);
      writeFileSync(join(directory, "source.txt"), "NodeForge isolated namespace fixture\n");
      manifest[kind] = { root: directory, sourceFile: "source.txt" };
      if (kind === "acl") {
        const denied = join(directory, "denied.txt");
        writeFileSync(denied, "Real ACL denial\n", { mode: 0o644 });
        chownSync(denied, 1000, 1000);
        namespaceCommand("setfacl", ["-m", "u:0:---", denied]);
        manifest.acl.deniedFile = "denied.txt";
      } else if (kind === "readonly") {
        namespaceCommand("mount", ["--bind", directory, directory]);
        mounted.push(directory);
        namespaceCommand("mount", ["-o", "remount,bind,ro", directory]);
      } else {
        const fd = openSync(join(directory, "filler"), "wx");
        let full = false;
        try {
          for (let count = 0; count < 512; count++) writeSync(fd, Buffer.alloc(4096));
        } catch (error) {
          if (error.code !== "ENOSPC") throw error;
          full = true;
        } finally { closeSync(fd); }
        if (!full || statfsSync(directory).bfree !== 0) throw new Error("VERIFICATION_BLOCKED: tmpfs not full");
      }
    }
    mkdirSync(join(root, "work"));
    chownSync(join(root, "work"), 0, 0);
    const content = JSON.stringify(manifest, null, 2) + "\n";
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, content, { mode: 0o644 });
    return { manifest, manifestPath, checksum: createHash("sha256").update(content).digest("hex"), cleanup };
  } catch (error) {
    console.error("Namespace fixture provisioning failed:", error);
    cleanup();
    throw error;
  }
}
