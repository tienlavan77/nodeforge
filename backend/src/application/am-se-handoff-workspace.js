// Business purpose: detects workspace drift before a handoff role can act on saved evidence.
// Technical description: binds HEAD and every Git-visible changed or untracked file to its bytes using project FileService.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";

// Business purpose: refuses to certify an incomplete or unreadable workspace snapshot.
// Technical description: returns a bounded conflict code rather than accepting a partial fingerprint.

function unsafe() { throw Object.assign(new ConfigurationError("Workspace snapshot unavailable."), { code: "HANDOFF_WORKSPACE_UNAVAILABLE", statusCode: 409 }); }

// Business purpose: captures a content-bound workspace baseline for handoff transition guards.
// Technical description: parses Git porcelain -z, hashes tracked changes and untracked files, and rejects unsupported states.
export async function handoffWorkspaceSnapshot({ gitService, fileService, projectId, scopePaths } = {}) {
  if (!projectId || !gitService?.getHead || !gitService?.status || !gitService?.indexEntries || !fileService?.readFile) unsafe();
  const head = await gitService.getHead();
  const porcelain = await gitService.status({ nulTerminated: true });
  const index = await gitService.indexEntries();
  if (typeof porcelain !== "string" || typeof index !== "string" || Buffer.byteLength(index) > 16 * 1024 * 1024 || typeof head !== "string" || !head.trim()) unsafe();
  const entries = porcelain ? porcelain.split("\0") : [];
  if (entries.at(-1) === "") entries.pop();
  if (entries.length > 2048 || Buffer.byteLength(porcelain) > 1024 * 1024 || index.split("\0").length > 200_000) unsafe();
  for (const entry of index.split("\0").filter(Boolean)) {
    if (!/^[0-7]{6} [0-9a-f]{40,64} [0-3]\t[^\0]+$/i.test(entry)) unsafe();
  }
  const paths = [];
  for (let i = 0; i < entries.length; i += 1) {
    const item = entries[i];
    if (!item || item.length < 4 || item[2] !== " " || !/^[ MARCUD?!]{2}$/.test(item.slice(0, 2))) unsafe();
    const state = item.slice(0, 2);
    const path = item.slice(3);
    if (!path || path.startsWith("/") || path.split("/").includes("..") || path.includes("\\")) unsafe();
    paths.push({ path, deleted: state.includes("D") && !state.includes("M") && !state.includes("A") });
    if (state.includes("R") || state.includes("C")) {
      const oldPath = entries[++i];
      if (!oldPath || oldPath.startsWith("/") || oldPath.split("/").includes("..")) unsafe();
      paths.push({ path: oldPath, deleted: true });
    }
  }
  if (Array.isArray(scopePaths)) {
    const scope = [...new Set(scopePaths)].sort();
    if (scope.some((path) => typeof path !== "string" || !path || path.startsWith("/") || path.split("/").includes("..") || path.includes("\\"))) unsafe();
    const changed = new Map(paths.map((item) => [item.path, item]));
    const files = {};
    for (const path of scope) {
      const change = changed.get(path);
      if (change?.deleted) { files[path] = "deleted"; continue; }
      try {
        const bytes = await fileService.readFile({ path, encoding: null });
        if (!Buffer.isBuffer(bytes) && typeof bytes !== "string") unsafe();
        files[path] = createHash("sha256").update(bytes).digest("hex");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        files[path] = "missing";
      }
    }
    const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
    return { project_id: projectId, head, fingerprint: digest, files, scope_paths: scope, index_hash: null };
  }
  const digest = createHash("sha256");
  const files = {};
  digest.update(head); digest.update("\0"); digest.update(porcelain); digest.update("\0"); digest.update(index);
  for (const item of paths.sort((a, b) => a.path.localeCompare(b.path))) {
    digest.update("\0"); digest.update(item.path); digest.update("\0");
    if (item.deleted) { digest.update("deleted"); files[item.path] = "deleted"; continue; }
    let bytes;
    try { bytes = await fileService.readFile({ path: item.path, encoding: null }); }
    catch (error) { void error; unsafe(); }
    if (!Buffer.isBuffer(bytes) && typeof bytes !== "string") unsafe();
    const hash = createHash("sha256").update(bytes).digest("hex");
    files[item.path] = hash;
    digest.update(hash);
  }
  return { project_id: projectId, head, fingerprint: digest.digest("hex"), files, index_hash: createHash("sha256").update(index).digest("hex") };
}
