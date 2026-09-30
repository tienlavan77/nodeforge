// Serves Reviewer source from the ticket commit rather than mutable project-root files.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { createTicketRootGit } from "./ticket-root-git.js";

const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });

// Creates a read-only File Service view of the ticket's persisted review commit.
export function createTicketCommitFileService({ taskId, projectRoot, executionContexts }) {
  if (!taskId || !executionContexts?.load) throw fail("CONFIGURATION_ERROR", "Committed Reviewer source requires a ticket context.");
  const git = createTicketRootGit({ projectRoot });
  return Object.freeze({ readFile, readForIndex, listFiles, listDirectories });

  // Resolves the immutable commit selected for this ticket's review.
  async function commit() {
    const context = await executionContexts.load(taskId);
    if (!context?.review_commit_sha) throw fail("REVIEW_COMMIT_MISSING", "Ticket has no committed source for Reviewer reads.");
    await git.assertAncestor(context.review_commit_sha);
    return context.review_commit_sha;
  }

  // Reads an approved text file from the committed Git tree.
  async function readFile({ path }) {
    if (typeof path !== "string" || !path || path.startsWith("/") || path.split("/").includes("..")) throw fail("REVIEW_PATH_INVALID", "Reviewer path is invalid.");
    const content = await git.fileAt(await commit(), path);
    if (content === null) throw Object.assign(new Error(`File does not exist: ${path}`), { code: "ENOENT" });
    if (content.includes("\0")) throw fail("REVIEW_BINARY_FORBIDDEN", "Reviewer cannot read binary source.");
    return content;
  }

  // Returns the bounded File Service metadata used by shared Reviewer read tools.
  async function readForIndex({ path, maxBytes = 64_000 }) {
    const content = await readFile({ path });
    const size = Buffer.byteLength(content);
    if (size > maxBytes) throw fail("FILE_TOO_LARGE", "Reviewer source exceeds the file read limit.");
    return { path, content, size_bytes: size, sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`, total_lines: content.split("\n").length };
  }

  // Lists files from the commit tree for bounded Reviewer discovery.
  async function listFiles() {
    return (await git.run(["ls-tree", "-r", "--name-only", await commit()])).split("\n").filter(Boolean);
  }

  // Lists directories implied by committed file paths, including empty-root discovery.
  async function listDirectories() {
    const files = await listFiles();
    const directories = new Set();
    for (const path of files) {
      const parts = path.split("/");
      for (let count = 1; count < parts.length; count += 1) directories.add(parts.slice(0, count).join("/"));
    }
    return [...directories].sort();
  }
}
