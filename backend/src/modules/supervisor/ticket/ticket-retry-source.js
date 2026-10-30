/** Separates retry ownership from mutable implementation source. Shared-root
 * Coders may continue reading the current revision after a checkpoint; Reviewer
 * evidence and isolated workspaces retain their exact snapshot requirements. */
import { ConfigurationError } from "../../../shared/errors.js";

const SOURCE_FIELDS = ["source_revision", "manifest_sha", "review_commit_sha"];
const OWNER_FIELDS = ["task_id", "project_id", "supervisor_id", "base_sha", "execution_root"];

/** Checks technical dispatch identity without deciding whether changed code is
 * correct. Execution, cancellation and plan checks remain the callers' job;
 * checksum, claim and commit checks remain at their mutation boundaries. */
export function matchesTicketRetrySource({ workspace, current, expected, reviewResume = false }) {
  if (!current || !expected || current.state === "terminal"
    || OWNER_FIELDS.some((field) => current[field] !== expected[field])) return false;
  return workspace?.root_only && !reviewResume
    || SOURCE_FIELDS.every((field) => current[field] === expected[field]);
}

/** Records a fresh Coder dispatch snapshot while preserving the old checkpoint
 * as history. This does not adopt external bytes, approve writes or reuse stale
 * verification; it only permits the agent to assess current source. */
export function assertTicketRetrySource({ workspace, current, expected, reviewResume, taskId, projectLogger }) {
  if (!expected) return;
  if (!matchesTicketRetrySource({ workspace, current, expected, reviewResume })) throw Object.assign(
    new ConfigurationError("Ticket retry ownership or immutable review source changed during preparation."),
    { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
  const changed = SOURCE_FIELDS.filter((field) => current[field] !== expected[field]);
  if (changed.length) projectLogger({ event_name: "ticket.retry_source_refreshed", level: "info", status: "success", task_id: taskId,
    message: "Coder retry uses the current ticket source context and retained checkpoint; source assessment remains with the agent.",
    payload: { changed_fields: changed, previous_source_revision: expected.source_revision, source_revision: current.source_revision } });
}
