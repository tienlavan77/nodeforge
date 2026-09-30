// Records per-event immutable ticket identity comparisons while legacy routing remains authoritative.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { acquireTicketFileLock } from "./ticket-file-lock.js";

const EVENT_TYPES = new Set(["verification.passed", "review.approved", "task.completed"]);
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");

// Creates a read-only shadow comparator with durable, idempotent event receipts.
export function createTicketPipelineShadow({ projectId, fileService, rollout, projectLogger = () => {} } = {}) {
  if (!projectId || !fileService?.readFile || !fileService?.atomicWrite || !fileService?.createLock || !rollout?.load) throw new ConfigurationError("Ticket shadow comparison requires project persistence and rollout mode.");
  const projectHash = hash(projectId);
  const root = `.forge/runtime/ticket-pipeline-shadow/${projectHash}`;
  return Object.freeze({ compare });

  // Compares one execution event with persisted context, artifact, review, and integration IDs.
  async function compare(event) {
    const type = event?.type ?? event?.event_type;
    if (!EVENT_TYPES.has(type) || !SAFE_ID.test(event?.event_id ?? "") || !SAFE_ID.test(event?.task_id ?? "")) return null;
    if ((await rollout.load()).mode !== "shadow") return null;
    const path = `${root}/${event.event_id}.json`;
    const lock = await acquireTicketFileLock(fileService, `${path}.lock`);
    try {
      const prior = await read(path);
      if (prior) return prior;
      const context = await read(`.forge/runtime/ticket-execution-contexts/${projectHash}/${event.task_id}.json`);
      const artifact = context?.verification_artifact_id ? await read(`.forge/runtime/ticket-verification/${event.task_id}/artifacts/${context.verification_artifact_id}.json`) : null;
      const review = await read(`.forge/runtime/reviewer-checkpoints/${event.task_id}.json`);
      const integration = await read(`.forge/runtime/ticket-integrations/${event.task_id}.json`);
      const checks = {
        context_project: context?.project_id === projectId,
        artifact_id: Boolean(artifact && context?.verification_artifact_id === artifact.artifact_id),
        base_sha: Boolean(artifact && context?.base_sha === artifact.base_sha),
        source_revision: Boolean(artifact && context?.source_revision === artifact.source_revision),
        manifest_sha: Boolean(artifact && context?.manifest_sha === artifact.manifest_sha),
        commit_sha: Boolean(artifact && context?.review_commit_sha === artifact.commit_sha),
        manifest_paths: Boolean(artifact && JSON.stringify([...(context?.manifest_paths ?? [])].sort()) === JSON.stringify(Object.keys(artifact.file_checksums ?? {}).sort())),
        ...(type === "verification.passed" ? {} : {
          review_approved: review?.status === "completed" && review.verdict === "approved",
          review_artifact: Boolean(review && artifact && review.verification?.artifact_id === artifact.artifact_id)
        }),
        ...(type === "task.completed" ? { integration_commit: integration?.status === "completed" && integration.reviewed_commit === context?.review_commit_sha } : {})
      };
      const status = !context || !artifact || (type !== "verification.passed" && !review) || (type === "task.completed" && !integration) ? "unavailable" : Object.values(checks).every(Boolean) ? "match" : "mismatch";
      const record = { event_id: event.event_id, event_type: type, task_id: event.task_id, project_id: projectId, status, checks, identity: { context_version: context?.version ?? null, base_sha: context?.base_sha ?? null, source_revision: context?.source_revision ?? null, manifest_sha: context?.manifest_sha ?? null, review_commit_sha: context?.review_commit_sha ?? null, artifact_id: artifact?.artifact_id ?? null, reviewer_id: review?.reviewer_id ?? null, integration_commit_sha: integration?.commit ?? null }, compared_at: new Date().toISOString() };
      await fileService.atomicWrite({ path, content: `${JSON.stringify(record)}\n`, replace: false });
      projectLogger({ event_name: "ticket.pipeline_shadow_compared", level: status === "match" ? "info" : "warning", status: status === "match" ? "success" : "failed", message: "Ticket event identity compared in shadow mode.", task_id: event.task_id, source: "ticket-pipeline-shadow", payload: { event_id: event.event_id, event_type: type, comparison_status: status } });
      return record;
    } finally { await lock.release(); }
  }

  // Reads only persisted identity metadata from Forge File Service.
  async function read(path) {
    try { return JSON.parse(await fileService.readFile({ path })); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
}
