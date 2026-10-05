// Routes owner-approved Git workspace commits through the validated Git service.
import { ConfigurationError } from "../../shared/errors.js";
import { requireProject, unavailable } from "./forge-v1-router-utils.js";

// Handles safe Git status, commit, and push requests for the configured project.
export async function routeForgeV1Git({ method, parts, body, projectId, expectedProjectId, gitService }) {
  if (method === "GET" && parts.length === 1 && ["health", "version"].includes(parts[0])) {
    return { status: 200, body: parts[0] === "health" ? { status: "ok", service: "nodeforge" } : { api: "forge/v1", service: "nodeforge" } };
  }
  if (parts[0] !== "git") return null;
  if (method === "GET" && parts.length === 2 && parts[1] === "status") {
    assertProject(projectId, expectedProjectId, "Git status project is unavailable.");
    if (!gitService?.statusSummary) throw unavailable("Git Status");
    return { status: 200, body: await gitService.statusSummary() };
  }
  if (method !== "POST" || parts.length !== 2 || parts[1] !== "commit-push") return null;
  assertProject(projectId, expectedProjectId, "Git project is unavailable.");
  if (!gitService?.status || !gitService?.commit || !gitService?.pushCommit) throw unavailable("Git Commit and Push");
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > 200) throw Object.assign(new ConfigurationError("A commit message of 1–200 characters is required."), { statusCode: 400, code: "GIT_COMMIT_MESSAGE_INVALID" });
  const changedPaths = parseChangedPaths(await gitService.status({ nulTerminated: true }));
  if (!changedPaths.length) throw Object.assign(new ConfigurationError("There are no changed files to commit."), { statusCode: 409, code: "GIT_NO_CHANGES" });
  const commit = await gitService.commit(message, { paths: changedPaths });
  try {
    const pushed = await gitService.pushCommit(commit.sha);
    return { status: 200, body: { status: "pushed", ...pushed, changed_files: changedPaths.length } };
  } catch (error) {
    console.error("Git push failed after commit", error);
    return { status: 200, body: { status: "push_failed", commit_sha: commit.sha, changed_files: changedPaths.length } };
  }
}

// Rejects Git operations outside the configured project root.
function assertProject(projectId, expectedProjectId, message) {
  requireProject(projectId);
  if (projectId !== expectedProjectId) throw Object.assign(new ConfigurationError(message), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
}

// Extracts changed working-tree paths from NUL-delimited porcelain records.
function parseChangedPaths(porcelain) {
  const records = porcelain.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const path = record.slice(3);
    if (path) paths.push(path);
    if (/[RC]/.test(record.slice(0, 2))) index += 1;
  }
  return [...new Set(paths)];
}
