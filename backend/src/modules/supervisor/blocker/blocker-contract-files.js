/** Separates Node-owned AM authority receipts from agent source-file readers.
 * Only receipts already authenticated for this execution by the contract store
 * receive exact read grants; repository and agent-tool permissions stay intact. */
import { createHash } from "node:crypto";
import { statePath } from "../../../infrastructure/filesystem/forge-paths.js";

/** Wraps validation reads with the Node state service for authenticated receipt
 * paths. Every use rechecks immutable bytes; these internal grants are never
 * added to an agent's filesystem tools or inferred from its submitted evidence. */
export function createBlockerContractFiles({ files, stateFiles, receipts = [], job }) {
  const grants = new Map(receipts.filter((receipt) => /^[a-f0-9]{64}$/.test(receipt.sha256 ?? "")
    && receipt.path === statePath("blocker-contract-decisions", `${receipt.sha256}.json`)
    && receipt.record?.project_id === job.request?.project_id && receipt.record?.task_id === job.request?.task_id
    && (receipt.record.execution_id === job.request?.payload?.execution_id || receipt.continuation?.execution_id === job.request?.payload?.execution_id)
    && receipt.record.validation_status === "validated_technical_contract"
    && receipt.record.disposition?.authority_scope === "architecture" && receipt.record.disposition.action === "resolved")
    .map((receipt) => [receipt.path, receipt]));
  if (!grants.size || typeof stateFiles?.readFile !== "function") return files;
  return { ...files,
    assertReadPath: (path) => grants.has(path) ? Promise.resolve() : files.assertReadPath(path),
    readFile: async (input) => {
      const receipt = grants.get(input.path);
      if (!receipt) return files.readFile(input);
      const content = await stateFiles.readFile({ path: input.path });
      if (createHash("sha256").update(content).digest("hex") !== receipt.sha256)
        throw Object.assign(new Error("Authenticated AM receipt changed during disposition validation."), { code: "BLOCKER_CONTRACT_EVIDENCE_INVALID" });
      return content;
    }
  };
}
