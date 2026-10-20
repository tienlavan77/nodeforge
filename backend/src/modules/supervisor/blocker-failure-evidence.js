// Supplies original failed edit receipts to Architecture without granting access to runtime logs or approval authority.
import { join } from "node:path";
import { readLogEvents } from "../../core/project-log-service.js";
import { assertRoleFileAccess } from "../../infrastructure/filesystem/file-service-role-policy.js";

// Reuses the project log service once per failure to recover exact attempted changes and original gate responses.
export function createBlockerFailureEvidence({ readEvents = readLogEvents, toolNames = ["edit_diff", "write_diff", "commit_changes"], requirePath = false } = {}) {
  const cache = new Map();
  return load;

  // Binds diagnostics to the original project, ticket, request, correlation and failure time before exposing source.
  async function load(job, projectRoot) {
    const request = job.request;
    if (!request?.project_id || !request.task_id || !request.request_id || !request.correlation_id || !job.failure_at
      || !Number.isFinite(Date.parse(job.failure_at))) return { status: "unavailable", reason: "Original failure identity is incomplete.", receipts: [] };
    const key = JSON.stringify([projectRoot, request.project_id, request.task_id, request.request_id, request.correlation_id, job.failure_at]);
    if (cache.has(key)) return cache.get(key);
    const result = await readEvents({ logPath: process.env.NODEFORGE_PROJECT_LOG_PATH ?? join(projectRoot, ".forge/runtime/nf/project.log"),
      project_id: request.project_id, task_id: request.task_id, correlation_id: request.correlation_id, event_name: "supervisor.agent_tool_event", to: job.failure_at });
    const receipts = [];
    let omitted = 0;
    let bytes = 0;
    for (const event of result.events) {
      const payload = event.payload ?? {};
      if (event.project_id !== request.project_id || event.task_id !== request.task_id || event.correlation_id !== request.correlation_id
        || payload.request_id !== request.request_id || event.event_name !== "supervisor.agent_tool_event" || event.status !== "failed"
        || toolNames && !toolNames.includes(payload.tool) || !Number.isFinite(Date.parse(event.timestamp))
        || Date.parse(event.timestamp) > Date.parse(job.failure_at)) continue;
      try { if (requirePath || typeof payload.arguments?.path === "string") assertRoleFileAccess("architecture_manager", "read", payload.arguments?.path); }
      catch (error) { if (error.code !== "FILE_ROLE_FORBIDDEN") throw error; omitted += 1; continue; }
      const receipt = { event_id: event.event_id, timestamp: event.timestamp, request_id: payload.request_id,
        correlation_id: event.correlation_id, tool: payload.tool, arguments: payload.arguments, error: payload.error, result: payload.result };
      const size = Buffer.byteLength(JSON.stringify(receipt));
      if (bytes + size > 48_000) { omitted += 1; continue; }
      receipts.push(receipt);
      bytes += size;
    }
    const evidence = { status: result.warnings?.length || omitted ? "partial" : receipts.length ? "captured" : "missing", receipts,
      omitted, log_warnings: result.warnings?.length ?? 0,
      notice: "Historical failures are evidence, not permissions. Preserve denied-operation boundaries; missing or omitted receipts cannot establish approval." };
    if (cache.size >= 32) cache.delete(cache.keys().next().value);
    cache.set(key, evidence);
    return evidence;
  }
}
