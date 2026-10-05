// Materializes one committed ticket tree for verification without creating a Git worktree.
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";

const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });

// Creates a disposable archive and exposes a cleanup callback to the verification job.
export async function materializeTicketArchive({ projectRoot, commitSha }) {
  if (!/^[a-f0-9]{40,64}$/i.test(commitSha ?? "")) throw fail("TICKET_ARCHIVE_COMMIT_INVALID", "Archive verification requires a commit SHA.");
  const archiveRoot = join(projectRoot, ".forge", "runtime", "ticket-verification", "archives");
  await mkdir(archiveRoot, { recursive: true });
  const path = await mkdtemp(join(archiveRoot, "nodeforge-ticket-archive-"));
  try {
    await unpack(projectRoot, commitSha, path);
    for (const relative of (await readdir(path, { recursive: true })).filter((item) => item === ".gitmodules" || item.endsWith("/.gitmodules") || item === ".gitattributes" || item.endsWith("/.gitattributes"))) {
      if (relative.endsWith(".gitmodules") || /filter\s*=\s*lfs/.test(await readFile(join(path, relative), "utf8"))) throw fail("TICKET_ARCHIVE_UNSUPPORTED", "Git submodules or LFS need a materialization policy before archive verification.");
    }
    for (const relative of ["node_modules", "backend/node_modules", "ui/nextjs/node_modules"]) {
      const source = join(projectRoot, relative);
      try { await lstat(source); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const target = join(path, relative);
      await mkdir(dirname(target), { recursive: true });
      await symlink(source, target, "dir");
    }
    const tempDir = join(path, ".forge-tmp");
    await mkdir(tempDir, { recursive: true });
    return { path, temp_dir: tempDir, method: "git-archive", commit_sha: commitSha, cleanup: () => rm(path, { recursive: true, force: true }) };
  } catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
}

// Pipes Git archive directly into tar so the source tree stays immutable in Git.
function unpack(projectRoot, commitSha, destination) {
  return new Promise((resolve, reject) => {
    const archive = spawn("git", ["-C", projectRoot, "archive", "--format=tar", commitSha], { stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-x", "-C", destination], { stdio: ["pipe", "ignore", "pipe"] });
    archive.stdout.pipe(tar.stdin);
    let errors = "";
    archive.stderr.on("data", (part) => { errors = (errors + part).slice(-2048); });
    tar.stderr.on("data", (part) => { errors = (errors + part).slice(-2048); });
    let archiveCode;
    let tarCode;
    let settled = false;
    const finish = () => {
      if (settled || archiveCode === undefined || tarCode === undefined) return;
      settled = true;
      if (archiveCode === 0 && tarCode === 0) resolve();
      else reject(fail("TICKET_ARCHIVE_FAILED", `Git archive materialization failed: ${errors}`));
    };
    archive.once("error", (error) => { if (!settled) { settled = true; tar.kill(); reject(error); } });
    tar.once("error", (error) => { if (!settled) { settled = true; archive.kill(); reject(error); } });
    archive.once("close", (code) => { archiveCode = code; finish(); });
    tar.once("close", (code) => { tarCode = code; finish(); });
  });
}
