// Persists one terminal ticket integration receipt for root and worktree workflows.
import { ConfigurationError } from "../../shared/errors.js";

const DIRECTORY = ".forge/runtime/ticket-integrations";
const SAFE_TASK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });

// Give all workspace modes the same durable prepared and completed receipt contract.
export function createTerminalReceiptWriter({ fileService, projectLogger = () => {} } = {}) {
  if (!fileService?.readFile || !fileService?.atomicWrite) throw fail("CONFIGURATION_ERROR", "Terminal receipts require File Service.");
  return Object.freeze({ path, load, savePrepared, saveCompleted, loadIfCompleted });

  // Keep receipt paths ticket scoped and reject traversal before File Service access.
  function path(taskId) {
    if (!SAFE_TASK.test(taskId ?? "")) throw fail("TICKET_RECEIPT_ID_INVALID", "Terminal receipt requires a safe ticket ID.");
    return `${DIRECTORY}/${taskId}.json`;
  }

  // Load a receipt without treating corrupt JSON as an absent integration.
  async function load(taskId) {
    try {
      const receipt = JSON.parse(await fileService.readFile({ path: path(taskId) }));
      validate(taskId, receipt);
      return receipt;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (error instanceof SyntaxError) throw fail("TICKET_RECEIPT_INVALID", "Terminal receipt contains invalid JSON.");
      throw error;
    }
  }

  // Persist the intent before a Git ref move or root-only completion check.
  async function savePrepared(taskId, receipt) { return save(taskId, receipt, "prepared"); }

  // Confirm a verified integration while retaining its original identity.
  async function saveCompleted(taskId, receipt) { return save(taskId, receipt, "completed"); }

  // Return only terminal evidence for idempotency and downstream gates.
  async function loadIfCompleted(taskId) {
    const receipt = await load(taskId);
    return receipt?.status === "completed" ? receipt : null;
  }

  // Atomically replace the receipt through Forge File Service and log metadata only.
  async function save(taskId, receipt, status) {
    const next = { ...receipt, status };
    validate(taskId, next);
    await fileService.atomicWrite({ path: path(taskId), content: `${JSON.stringify(next)}\n`, replace: true });
    projectLogger({ event_name: "ticket.integration_receipt_saved", level: "info", status: "success", message: "Ticket integration receipt persisted.", task_id: taskId, source: "terminal-receipt-writer", payload: { phase: status, workspace_mode: next.workspace_mode ?? "worktree", commit: next.commit } });
    return next;
  }

  // Reject incomplete or mismatched receipts before a terminal gate trusts them.
  function validate(taskId, receipt) {
    if (!receipt || typeof receipt !== "object" || receipt.task_id !== taskId || !["prepared", "completed"].includes(receipt.status)
      || ![receipt.branch, receipt.previous_head, receipt.reviewed_commit, receipt.commit].every((value) => typeof value === "string" && value.length > 0)) {
      throw fail("TICKET_RECEIPT_INVALID", "Terminal receipt does not match its ticket or reviewed commit.");
    }
  }
}
