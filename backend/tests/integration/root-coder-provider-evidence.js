// Checks durable commit and report evidence for a live root-only Coder canary.
import assert from "node:assert/strict";
import { execFile as callback } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(callback);

// Classify approval failures without mistaking a reviewer outage for a policy denial.
function classifyToolFailure(event) {
  const message = String(event.payload?.error?.message ?? "");
  const approvalFailed = message.includes("Automatic approval review failed");
  const status = approvalFailed ? Number(message.match(/unexpected status (\d{3})\b/)?.[1] ?? 0) : 0;
  const cause = approvalFailed
    ? status >= 500 || status === 429 ? "auto_review_service_unavailable" : "auto_review_failed_unknown"
    : message.includes("rejected due to unacceptable risk") ? "approval_denied" : "tool_failed";
  return { tool: event.payload?.tool ?? null, cause, ...(status ? { reviewer_http_status: status } : {}) };
}

// Waits for report_done before the canary-owned API is shut down.
export async function waitForCoderReport(root, ticketId) {
  const path = join(root, ".forge/runtime/agent-checkpoints", `${ticketId}.json`);
  for (let attempt = 0; attempt < 360; attempt += 1) {
    const checkpoint = await readFile(path, "utf8").then(JSON.parse).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (checkpoint?.status === "completed" && checkpoint.last_tool === "report_done") return checkpoint;
    if (checkpoint?.status === "blocked") throw new Error(`Coder checkpoint blocked: ${checkpoint.failure?.code ?? "unknown"}`);
    const log = await readFile(join(root, ".forge/runtime/nf/project.log"), "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
    const events = log.split("\n").slice(-40).filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.task_id === ticketId);
    const failed = events.find((event) => event.event_name === "supervisor.tool_ticket_failed");
    if (failed) {
      const toolFailures = events.filter((event) => event.event_name === "supervisor.agent_tool_event" && event.status === "failed").map(classifyToolFailure);
      throw new Error(`Coder ended before report_done: ${JSON.stringify({ code: failed.error_code ?? "unknown", tool_failures: toolFailures })}`);
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error("Real Coder did not complete report_done within six minutes.");
}

// Verifies the exact root commit, archive artifact, and report after Coder completion.
export async function inspectRootCoderCanary(root, ticketId) {
  const checkpoint = JSON.parse(await readFile(join(root, ".forge/runtime/agent-checkpoints", `${ticketId}.json`), "utf8"));
  const contextRoot = join(root, ".forge/runtime/ticket-execution-contexts");
  const contextHash = (await readdir(contextRoot))[0];
  const context = JSON.parse(await readFile(join(contextRoot, contextHash, `${ticketId}.json`), "utf8"));
  const artifact = JSON.parse(await readFile(join(root, ".forge/runtime/ticket-verification", ticketId, "artifacts", `${context.verification_artifact_id}.json`), "utf8"));
  const commit = (await execFile("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  const tree = (await execFile("git", ["-C", root, "rev-parse", `${commit}^{tree}`])).stdout.trim();
  assert.equal(artifact.status, "passed");
  assert.equal(artifact.materialization_method, "git-archive");
  assert.equal(artifact.commit_sha, commit);
  assert.equal(artifact.tree_sha, tree);
  assert.equal(artifact.manifest_sha, context.manifest_sha);
  assert.ok(checkpoint.completed_tools.includes("commit_changes"));
  assert.ok(checkpoint.completed_tools.includes("report_done"));
  assert.match(await readFile(join(root, ".forge/runtime/reports", `${ticketId}.md`), "utf8"), /Real provider witness/);
  assert.deepEqual(await readdir(join(root, ".forge/runtime/reviewer-checkpoints")).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error)), []);
  return { package_id: "root-only-coder", task_id: ticketId, commit_sha: commit, tree_sha: tree, manifest_sha: artifact.manifest_sha, artifact_id: artifact.artifact_id, materialization_method: artifact.materialization_method, last_tool: checkpoint.last_tool, reviewer_checkpoint: "absent", report_path: `.forge/runtime/reports/${ticketId}.md` };
}
