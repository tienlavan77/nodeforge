// Diagnoses missing project dependencies separately from ticket commit ownership.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTicketRootGit } from "../ticket/ticket-root-git.js";

// Confirms whether a reported missing module belongs to the immutable commit or only the current workspace.
export async function inspectVerificationSource({ projectRoot, context, diagnostic, rootGit }) {
  if (!/^[a-f0-9]{40,64}$/i.test(context.review_commit_sha ?? "")) return { status: "unavailable", reason: "No immutable Git commit identity." };
  const paths = new Set();
  for (const command of diagnostic?.commands ?? []) {
    if (command.exit_code === 0) continue;
    const output = `${command.stdout_redacted ?? ""}\n${command.stderr_redacted ?? ""}`;
    for (const match of output.matchAll(/Cannot find module ['"]([^'"\n]+)['"]/g)) {
      const archive = /\/\.forge\/runtime\/(?:tickets\/)?ticket-verification\/archives\/nodeforge-ticket-archive-[^/]+\/(.+)$/.exec(match[1]);
      if (archive && /^(backend|ui|web|schemas)\//.test(archive[1])) paths.add(archive[1]);
    }
  }
  const git = rootGit ?? createTicketRootGit({ projectRoot });
  const files = [];
  for (const path of [...paths].sort().slice(0, 8)) {
    await git.assertSafePath(path);
    const mode = await git.modeAt(context.review_commit_sha, path);
    let content = null;
    try { content = await readFile(join(projectRoot, path)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    files.push({ path, commit_sha: context.review_commit_sha, committed: Boolean(mode), mode,
      workspace_present: content !== null, workspace_sha256: content === null ? null : `sha256:${createHash("sha256").update(content).digest("hex")}` });
  }
  return { status: "observed", commit_sha: context.review_commit_sha, files,
    interpretation: "Ticket paths are verified from the recorded ticket commit; other project files are captured separately as the verification environment, including uncommitted dependencies. Missing dependencies require inspection of the recorded environment and a fresh verification snapshot after repair, not a dependency commit or a new ticket commit. Do not expand ticket authorship or claim a workspace check is final acceptance." };
}
