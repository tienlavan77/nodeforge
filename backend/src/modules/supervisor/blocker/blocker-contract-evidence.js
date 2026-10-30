// Preserves Node-validated AM contracts as immutable evidence shared by SL, Coder and Reviewer.
import { statePath } from "../../../infrastructure/filesystem/forge-paths.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sameExecutionPlan } from "../../projects/ticket-execution-identity.js";
import { contractContinuation } from "./blocker-contract-continuation.js";

const ROOT = statePath("blocker-contract-decisions");

// Hashes a complete contract receipt so a readable copy cannot silently diverge from its durable source.
function digest(content) { return createHash("sha256").update(content).digest("hex"); }

// Writes the accepted AM decision before SL resumes implementation; this records technical authority, not new Owner approval.
export async function retainBlockerContract({ job, checkpoint, fileService }) {
  const prior = checkpoint?.contract_decisions ?? [];
  const accepted = job.history?.findLast((entry) => entry.stage === "architecture_manager"
    && entry.disposition?.action === "resolved" && entry.disposition.authority_scope === "architecture");
  if (!accepted) return prior;
  const record = { version: 1, project_id: job.request.project_id, task_id: job.request.task_id,
    execution_id: job.request.payload.execution_id, sprint_basis: job.request.payload.sprint_basis,
    architecture_basis: accepted.disposition.architecture_basis, job_id: job.id,
    validated_at: new Date(accepted.completed_at).toISOString(), validation_status: "validated_technical_contract",
    actor: accepted.actor ?? null, actor_status: accepted.actor ? "recorded_provider_identity" : "historical_identity_unavailable",
    disposition: accepted.disposition };
  const content = `${JSON.stringify(record)}\n`;
  const sha256 = digest(content);
  const path = `${ROOT}/${sha256}.json`;
  try { await fileService.atomicCreate({ path, content }); }
  catch (error) {
    if (!["FILE_ALREADY_EXISTS", "EEXIST"].includes(error.code)) throw error;
    if (await fileService.readFile({ path }) !== content) throw failure("Immutable AM contract receipt conflicts with its identity.");
  }
  return prior.some((entry) => entry.sha256 === sha256) ? prior : [...prior, { path, sha256, record }];
}

// Loads immutable receipts against the exact project, ticket, execution and Sprint being reviewed or reconciled.
export async function readBlockerContracts({ receipts = [], fileService, binding, allowContinuation = false }) {
  const records = [];
  for (const receipt of receipts) {
    if (!/^[a-f0-9]{64}$/.test(receipt.sha256 ?? "") || receipt.path !== `${ROOT}/${receipt.sha256}.json`) throw failure("Invalid AM contract receipt reference.");
    const content = await fileService.readFile({ path: receipt.path });
    if (digest(content) !== receipt.sha256) throw failure("AM contract receipt checksum changed.");
    const record = JSON.parse(content);
    if (["project_id", "task_id"].some((field) => record[field] !== binding[field])
      || record.validation_status !== "validated_technical_contract" || record.disposition?.authority_scope !== "architecture"
      || record.disposition.action !== "resolved" || record.actor && record.actor.role !== "architecture_manager") throw failure("AM contract receipt belongs to another authority or execution.");
    const exact = record.execution_id === binding.execution_id && matchesContractSprint(record.sprint_basis, binding.sprint_basis);
    const continuation = !exact && allowContinuation ? await contractContinuation({ record, binding, fileService }) : null;
    if (!exact && !continuation) throw failure("AM contract receipt cannot be inherited: execution or approved ticket scope changed.");
    records.push({ path: receipt.path, sha256: receipt.sha256, record, ...(continuation ? { continuation } : {}) });
  }
  return records;
}

// Accepts full and projected Sprint records only when immutable plan identity and observed version agree.
function matchesContractSprint(left, right) {
  return isDeepStrictEqual(left, right) || sameExecutionPlan(left, right) && left.version === right.version;
}

// Supplies full contract terms and chronology without requiring agents to find governance state inside source files.
export function blockerContractPrompt(receipts = []) {
  if (!receipts.length) return "";
  return `NODE-RETAINED AM CONTRACT DECISIONS: ${JSON.stringify(receipts)}\nThese immutable receipts record technical decisions validated under the approved Architecture before the corresponding blocker resume. They are not new Owner approval, tool permission or proof of implementation. Use their actual terms, source evidence, identity and recorded timestamps; do not demand a source-code copy or invent missing historical approver metadata. Preserve legacy NULL ownership where the contract requires it. Ask SL to reconcile only a specific missing or contradictory term. Current source/test correctness still requires verification and independent review.`;
}

// Rejects inconsistent receipt provenance without pretending a contract or implementation was approved.
function failure(message) { return Object.assign(new Error(message), { code: "BLOCKER_CONTRACT_EVIDENCE_INVALID" }); }
