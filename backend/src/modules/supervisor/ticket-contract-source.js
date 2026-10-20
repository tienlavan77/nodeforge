// Separates approved historical contract evidence from ticket-owned implementation changes at dispatch and recovery.
import { createHash } from "node:crypto";
import { createTicketRootGit } from "./ticket-root-git.js";
import { assertReviewerReadPath } from "./reviewer-forge-tools.js";
import { blockerValidationError } from "./blocker-validation.js";
import { findTicketContractHistory } from "./ticket-contract-history.js";

// Hashes exact file bytes while preserving intentional ticket deletions.
const hash = (content) => content === null ? null : typeof content === "string" || Buffer.isBuffer(content) ? createHash("sha256").update(content).digest("hex") : undefined;
// Reports unowned implementation drift separately from an unapproved contract.
const conflict = (message) => Object.assign(new Error(message), { code: "TICKET_CONTRACT_SOURCE_CONFLICT" });

// Creates a Node-only verifier pinned to the persisted workspace baseline, never an agent-selected Git revision.
export function createTicketContractSource({ request, workspace, git }) {
  const projectRoot = workspace.path ?? workspace.projectRoot;
  const files = workspace.root_only ? workspace.fileService : workspace.worktreeFileService ?? workspace.fileService;
  const rootGit = git ?? createTicketRootGit({ projectRoot });
  return verify;

  // Proves historical approval independently, then admits only live bytes explained by this ticket's journal.
  async function verify(ref) {
    if (!/^[a-f0-9]{64}$/.test(ref.sha256 ?? "")) throw blockerValidationError("/contract_evidence", "checksum_invalid", "Contract evidence requires the approved bare SHA-256.");
    await assertReviewerReadPath(projectRoot, ref.path);
    let content;
    try { content = await files.readFile({ path: ref.path }); }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "FILE_NOT_FOUND") throw error; content = null; }
    const currentSha = hash(content);
    const context = await workspace.executionContexts?.load?.(request.task_id);
    const baseline = context?.base_sha ?? workspace.base_commit;
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseline ?? "")) {
      if (currentSha !== ref.sha256) throw blockerValidationError("/contract_evidence", "contract_baseline_missing", "Historical contract baseline is unavailable; do not replace its SHA with current source.");
      return { path: ref.path, baseline_sha256: ref.sha256, current_sha256: currentSha, provenance: "unchanged_live", baseline_commit: null };
    }
    if (!context || context.task_id !== request.task_id || context.project_id !== request.project_id
      || workspace.base_commit !== baseline || request.execution_context?.base_sha && request.execution_context.base_sha !== baseline)
      throw conflict("Contract baseline does not belong to the retained ticket/project workspace.");
    await rootGit.assertAncestor(baseline);
    const original = await rootGit.fileAt(baseline, ref.path);
    const baselineSha = hash(original);
    let inherited = null;
    if (original === null || hash(original) !== ref.sha256) {
      const integrated = await workspace.findIntegratedSource?.(ref.path, ref.sha256, baselineSha, baseline);
      const approvedCommit = integrated && await findTicketContractHistory({ rootGit, baseline, path: ref.path, sha256: ref.sha256 });
      if (!approvedCommit) throw blockerValidationError("/contract_evidence", "contract_baseline_mismatch", "Approved contract checksum does not match the retained historical baseline; current edits cannot replace that approval.");
      inherited = { approved_commit: approvedCommit, integration: integrated };
      if (currentSha === baselineSha) return { path: ref.path, baseline_commit: baseline, ...inherited,
        baseline_sha256: ref.sha256, inherited_sha256: baselineSha, current_sha256: currentSha, provenance: "integrated_project_changes" };
    }
    const hasRepairHistory = context.review_repair_cycle_id || context.source_repair_cycle_id;
    if (!hasRepairHistory && currentSha !== ref.sha256) {
      const integrated = await workspace.findIntegratedSource?.(ref.path, ref.sha256, currentSha, baseline);
      if (integrated) return { path: ref.path, baseline_commit: baseline, baseline_sha256: ref.sha256, current_sha256: currentSha,
        provenance: "integrated_project_changes", integration: integrated };
    }
    let manifest;
    try { manifest = await workspace.changeLedger?.snapshot?.(); }
    catch (error) {
      if (!["TICKET_SOURCE_CHANGED", "TICKET_SOURCE_DRIFT", "FILE_CLAIM_CONFLICT"].includes(error.code)) throw error;
      throw conflict(`${error.code}: ${error.message}`);
    }
    const history = hasRepairHistory ? await workspace.loadReviewRepairSource?.(context) : [];
    if (!history) throw conflict("Archived repair source is unavailable.");
    const manifests = [...history, manifest];
    if (manifests.some((item) => item?.task_id !== request.task_id || item?.project_id !== request.project_id)) throw conflict("Contract source journal belongs to another ticket.");
    const entries = manifests.map((item) => item.entries?.[ref.path]).filter(Boolean);
    if (currentSha === ref.sha256 && !entries.length) return { path: ref.path, baseline_commit: baseline, baseline_sha256: ref.sha256, current_sha256: currentSha, provenance: "unchanged" };
    if (!entries.length && currentSha !== ref.sha256) {
      const integrated = await workspace.findIntegratedSource?.(ref.path, ref.sha256, currentSha, baseline);
      if (integrated) return { path: ref.path, baseline_commit: baseline, baseline_sha256: ref.sha256, current_sha256: currentSha,
        provenance: "integrated_project_changes", integration: integrated };
    }
    let cursor = `sha256:${baselineSha}`;
    if (!entries.length) throw conflict(`Current contract source is not explained by this ticket's baseline and completed writes: ${ref.path}.`);
    for (const entry of entries) {
      if (entry.pending || entry.initial_sha !== cursor || (entry.initial_content === null ? null : `sha256:${hash(entry.initial_content)}`) !== cursor || !entry.operations?.length)
        throw conflict(`Ticket contract source has a broken repair chain: ${ref.path}.`);
      for (const operation of entry.operations) {
        if (operation.status !== "completed" || operation.before_sha !== cursor
          || !(operation.before === null || typeof operation.before === "string") || !(operation.after === null || typeof operation.after === "string")
          || operation.before_sha !== (operation.before === null ? null : `sha256:${hash(operation.before)}`)
          || operation.after_sha !== (operation.after === null ? null : `sha256:${hash(operation.after)}`))
          throw conflict(`Ticket contract source has a broken write chain: ${ref.path}.`);
        cursor = operation.after_sha;
      }
      if (cursor !== entry.latest_sha) throw conflict(`Ticket contract source journal does not reach recorded bytes: ${ref.path}.`);
    }
    if (cursor !== (currentSha === null ? null : `sha256:${currentSha}`)) throw conflict(`Ticket contract source journal does not reach current bytes: ${ref.path}.`);
    return { path: ref.path, baseline_commit: baseline, baseline_sha256: ref.sha256, current_sha256: currentSha,
      ...(inherited ? { ...inherited, inherited_sha256: baselineSha } : {}), provenance: "ticket_owned_changes", ledger_revision: manifest.revision };
  }
}
