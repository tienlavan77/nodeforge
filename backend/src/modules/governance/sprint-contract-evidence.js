/** Repairs malformed source checksums in unadmitted Sprint drafts using trusted
 * Forge read metadata. Planning scope and approval quotes remain agent-authored;
 * existing valid baseline checksums are never replaced with newer source bytes. */
import { ConfigurationError } from "../../shared/errors.js";

const DIGEST = /^[a-f0-9]{64}$/;

/** Reuses request-local read receipts, or performs a role-authorized metadata
 * read when one is unavailable, to repair only invalid contract checksum fields.
 * The original draft stays unchanged if any source is missing or forbidden. */
export async function repairSprintContractEvidence(plan, { readReceipts = new Map(), readFile } = {}) {
  if (!Array.isArray(plan?.tickets)) return plan;
  let repaired;
  for (const [ticketIndex, ticket] of plan.tickets.entries()) {
    const refs = ticket?.execution_policy?.contract_evidence;
    if (!Array.isArray(refs)) continue;
    for (const [refIndex, ref] of refs.entries()) {
      if (!ref || typeof ref.path !== "string" || !ref.path || typeof ref.sha256 === "string" && DIGEST.test(ref.sha256)) continue;
      if (refs.length > 8) throw new ConfigurationError("Contract evidence exceeds the Sprint schema limit.");
      const receipt = readReceipts.get(ref.path) ?? await readFile?.(ref.path);
      const digest = typeof receipt?.sha256 === "string" ? receipt.sha256.replace(/^sha256:/, "") : "";
      if (receipt?.path !== ref.path || !DIGEST.test(digest)) throw Object.assign(new ConfigurationError(`A trusted Forge read checksum is required for contract evidence: ${ref.path}.`), { code: "SPRINT_CONTRACT_EVIDENCE_REQUIRED" });
      readReceipts.set(ref.path, { path: receipt.path, sha256: receipt.sha256 });
      repaired ??= structuredClone(plan);
      repaired.tickets[ticketIndex].execution_policy.contract_evidence[refIndex].sha256 = digest;
    }
  }
  return repaired ?? plan;
}
