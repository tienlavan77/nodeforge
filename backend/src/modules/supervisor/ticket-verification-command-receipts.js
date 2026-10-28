/** Retains completed ticket checks across failed attempts and API restarts.
 * Receipts reuse only PASS results from the same committed inputs, recorded
 * environment, installed dependency metadata, runner and ordered command plan.
 * Browser and external fixture checks always execute against their live runner. */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";

/** Produces stable receipt addresses without persisting environment secrets. */
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Detects dependency installation changes in npm and pnpm layouts, including
 * projects whose lockfiles have not changed during a reinstall. */
async function dependencyRevision(root) {
  const entries = [];
  for (const prefix of ["", "backend/", "ui/nextjs/"]) {
    for (const name of ["node_modules", "node_modules/.pnpm", "node_modules/.package-lock.json", "node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml"]) {
      const path = `${prefix}${name}`;
      try {
        const info = await stat(join(root, path));
        entries.push([path, info.dev, info.ino, info.mtimeMs, info.ctimeMs, info.isFile() ? digest(await readFile(join(root, path))) : null]);
      } catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; entries.push([path, null]); }
    }
  }
  return digest(entries);
}

/** Creates a durable PASS checkpoint for an isolated, source-bound verification
 * attempt. Failed commands and external checks never become reusable evidence.
 * Every successful command must leave its source inputs unchanged before save. */
export async function createTicketCommandReceipts({ projectRoot, stateFileService, taskId, job, context, checksums, environment, commands, assertInputs }) {
  if (!environment?.sha256 || !job.runner_revision) return null;
  const dependencies = await dependencyRevision(projectRoot);
  const env = Object.entries(process.env).filter(([key]) => !["PWD", "TMPDIR", "TMP", "TEMP", "NODE_TEST_CONTEXT"].includes(key)).sort(([a], [b]) => a.localeCompare(b));
  const binding = digest([taskId, context.review_commit_sha, checksums, environment.sha256, dependencies, job.policy_version, job.runner_revision, process.execPath, process.version, digest(env), commands]);
  /** Disables reuse for browser sessions, builds and provisioned filesystem runners. */
  const eligible = command => ["typecheck", "lint", "test", "backend_tests", "schema_validation"].includes(command.kind)
    && !command.environment && !command.argv.some(arg => arg.includes("project-filesystem-environment.test.js"));
  /** Keeps each receipt alongside ordinary verification checks for audit access. */
  const pathFor = command => `${statePath("ticket-verification")}/${taskId}/checks/CHECK-COMMAND-${digest([binding, command])}.json`;
  return {
    /** Restores original provenance instead of claiming an old PASS ran anew. */
    async load(command) {
      if (!eligible(command)) return null;
      const path = pathFor(command);
      let receipt;
      try { receipt = JSON.parse(await stateFileService.readFile({ path })); }
      catch (error) {
        if (error.code === "ENOENT") return null;
        if (error instanceof SyntaxError) { console.warn("Invalid verification command receipt; rerunning check.", { path, error: error.message }); return null; }
        throw error;
      }
      if (receipt?.binding !== binding || receipt.result?.exit_code !== 0 || receipt.result_sha256 !== digest(receipt.result)
        || digest(receipt.command) !== digest(command) || !receipt.job_id || !receipt.completed_at) return null;
      await assertInputs();
      if (await dependencyRevision(projectRoot) !== dependencies) return null;
      return { ...receipt.result, reused_from: { job_id: receipt.job_id, evidence_ref: path, completed_at: receipt.completed_at }, duration_ms: 0 };
    },
    /** Persists only validated PASS results, surviving a later command failure. */
    async save(command, result) {
      if (!eligible(command) || result.exit_code !== 0) return;
      await assertInputs();
      if (await dependencyRevision(projectRoot) !== dependencies) return;
      const receipt = { type: "verification_command", binding, command, result, result_sha256: digest(result), job_id: job.job_id, completed_at: new Date().toISOString() };
      await stateFileService.atomicWrite({ path: pathFor(command), content: `${JSON.stringify(receipt)}\n`, replace: true });
    }
  };
}
