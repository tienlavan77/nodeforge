// Validates AM's concrete contract handoff without treating a direction choice as exact contract approval.
import { createHash } from "node:crypto";
import { assertReviewerReadPath } from "../review/reviewer-forge-tools.js";
import { blockerValidationError } from "./blocker-validation.js";

// Requires source-backed design and an existing owner direction before Node stages a governance revision.
export async function validateBlockerContractDraft(value, { job, fileService, projectRoot }) {
  const draft = value.contract_draft;
  if (job.stage !== "architecture_manager" || !job.fulfillment_decision_id
    || !(job.owner_decisions ?? []).some((entry) => entry.decision_id === job.fulfillment_decision_id)) {
    throw blockerValidationError("/action", "contract_handoff_unavailable", "Only AM fulfilling a Node-recorded owner choice may stage a contract revision.");
  }
  if (!draft || Object.keys(draft).some((key) => !["title", "markdown", "evidence"].includes(key))
    || typeof draft.title !== "string" || !draft.title.trim() || draft.title.length > 200
    || typeof draft.markdown !== "string" || draft.markdown.trim().length < 100 || draft.markdown.length > 24_000
    || !Array.isArray(draft.evidence) || !draft.evidence.length || draft.evidence.length > 16) {
    throw blockerValidationError("/contract_draft", "contract_draft_incomplete", "Provide title, concrete Markdown contract (100-24000 characters), and 1-16 inspected source references.");
  }
  for (const [index, reference] of draft.evidence.entries()) {
    if (!reference || typeof reference.path !== "string" || !/^[a-f0-9]{64}$/.test(reference.sha256 ?? "")
      || Object.keys(reference).some((key) => !["path", "sha256"].includes(key))) {
      throw blockerValidationError(`/contract_draft/evidence/${index}`, "evidence_invalid", "Each source reference requires only path and full SHA-256.");
    }
    await assertReviewerReadPath(projectRoot, reference.path);
    const bytes = await fileService.readFile({ path: reference.path });
    if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) {
      throw blockerValidationError(`/contract_draft/evidence/${index}`, "evidence_stale", "Re-read changed contract evidence before proposing a revision.");
    }
  }
  return value;
}
