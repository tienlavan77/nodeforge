// Verifies committed ticket changes with a recorded snapshot of the surrounding project, including uncommitted dependencies.
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { materializeTicketArchive } from "./ticket-archive-materialization.js";
import { persistVerificationEnvironment } from "./ticket-verification-environment.js";

// Overlays only non-ticket environment files on the committed ticket tree and retains evidence without committing them.
export async function materializeTicketVerification({ projectRoot, commitSha, ticketPaths, environment }) {
  const archive = await materializeTicketArchive({ projectRoot, commitSha });
  try {
    const owned = new Set(ticketPaths);
    const present = new Set(environment.files.map((file) => file.path));
    // Removes deleted or unsupported environment entries while preserving committed ticket bytes and managed dependency links.
    for (const entry of await readdir(archive.path, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      const relative = join(entry.parentPath, entry.name).slice(archive.path.length + 1);
      if (relative.split("/").includes("node_modules") || owned.has(relative)) continue;
      if (!present.has(relative)) await rm(join(archive.path, relative), { force: true });
    }
    for (const file of environment.files) {
      const path = join(archive.path, file.path);
      await mkdir(dirname(path), { recursive: true });
      await rm(path, { force: true, recursive: true });
      await writeFile(path, file.bytes); await chmod(path, file.mode);
    }
    const ticketSource = new Map();
    for (const path of ticketPaths) ticketSource.set(path, await ticketFileHash(archive.path, path));
    return { ...archive, environment: await persistVerificationEnvironment(projectRoot, environment), method: "ticket-commit-with-project-environment",
      // Detects regression tests altering baseline ticket files before failure attribution.
      assertTicketSource: async () => {
        for (const [path, expected] of ticketSource) {
          if (await ticketFileHash(archive.path, path) !== expected) throw Object.assign(new Error(`Verification modified ticket source: ${path}.`), { code: "VERIFY_SOURCE_MISMATCH" });
        }
      },
      // Detects verification commands rewriting their recorded source dependencies without consulting live workspace changes.
      assertEnvironment: async () => {
        for (const file of environment.files) {
          const bytes = await readFile(join(archive.path, file.path));
          if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw Object.assign(new Error(`Verification modified an input dependency: ${file.path}.`), { code: "VERIFY_ENVIRONMENT_CHANGED" });
        }
      } };
  } catch (error) { await archive.cleanup(); throw error; }
}

// Preserves absent ticket files when comparing baseline source before and after test execution.
async function ticketFileHash(root, path) {
  try { return createHash("sha256").update(await readFile(join(root, path))).digest("hex"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
