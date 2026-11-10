// Business purpose: turns retrieval suggestions into trustworthy source receipts without claiming that an agent read the code.
// Technical description: reads authorized live bytes, extracts symbol bounds, and keeps verified metadata private to the tool result.
import { createHash } from "node:crypto";
import { extractorRegistry } from "../../modules/index/parser/index.js";
import { updateActiveFileChecksums } from "../../application/owner-context-compaction.js";
import { assertExecutionFileAccess } from "../execution-file-access.js";
import { isAgentPathAllowed } from "../governance/tool-authorization.js";
import { scopedGraph } from "./agent-file-index-view.js";
import { recordSourceMetadata } from "./source-metadata-receipts.js";

const verified = new WeakMap();

// Business purpose: prevents unverified candidate payloads from being persisted as source evidence.
// Technical description: only entries created by live validation can yield metadata to the evidence synchronizer.
export function candidateSourceMetadata(entry) {
  return entry && typeof entry === "object" ? verified.get(entry) : undefined;
}

// Business purpose: gives both cached and live candidates the same safe route to symbolic reading.
// Technical description: checks path authority around asynchronous reads, hashes actual content, and extracts fresh symbols before registration.
export async function registerCandidateSources(selected, context, { fileService, assertReadPath, allowPath = isAgentPathAllowed, logger = console } = {}) {
  const result = [];
  for (const candidate of selected) {
    const entry = { ...candidate, receipt: { status: "unavailable", read_symbol: false }, evidence: { status: "not_recorded", durable: false } };
    // Retrieval metadata never establishes freshness or symbol bounds by itself.
    delete entry.sha256; delete entry.symbol_map; delete entry.code_graph; delete entry.fresh;
    try {
      assertExecutionFileAccess(context);
      if (!allowPath(entry.path, context)) throw new Error("Candidate path is outside the issued read scope.");
      if (entry.stale) throw new Error("Candidate index metadata is stale; refresh discovery or read_file.");
      if (typeof fileService?.readForIndex !== "function") throw new Error("Live source validation is unavailable.");
      await assertReadPath?.(entry.path, context);
      const file = await fileService.readForIndex({ path: entry.path });
      assertExecutionFileAccess(context);
      if (!allowPath(entry.path, context)) throw new Error("Candidate read authority changed.");
      await assertReadPath?.(entry.path, context);
      if (typeof file?.content !== "string") throw new Error("Candidate source content is unavailable.");
      const sha256 = `sha256:${createHash("sha256").update(file.content).digest("hex")}`;
      const symbolMap = extractorRegistry.extract(entry.path, file.content).symbols;
      if (!Array.isArray(symbolMap)) throw new Error("Candidate symbol metadata is unavailable.");
      assertExecutionFileAccess(context);
      if (!allowPath(entry.path, context)) throw new Error("Candidate read authority changed before registration.");
      const graph = scopedGraph(file.code_graph, context);
      const metadata = { path: entry.path, sha256, symbol_map: symbolMap, total_lines: file.content.split("\n").length,
        code_graph: {
          imports: (graph.imports ?? []).filter((link) => allowPath(link.path, context)),
          imported_by: (graph.imported_by ?? []).filter((link) => allowPath(link.path, context)),
          calls: (graph.calls ?? []).filter((link) => allowPath(link.caller?.path, context) && allowPath(link.target?.path, context))
        }, index_status: "unavailable" };
      recordSourceMetadata(context, metadata);
      context.active_file_checksums = updateActiveFileChecksums(context.active_file_checksums, {
        toolName: "read_file", step: { tool_name: "read_file", path: entry.path }, result: metadata
      });
      Object.assign(entry, metadata, { fresh: true, receipt: { status: "verified", read_symbol: symbolMap.length > 0 } });
      verified.set(entry, metadata);
    } catch (error) {
      entry.receipt.error = String(error.message ?? error);
      (logger.warn ?? console.warn).call(logger, "Candidate source receipt unavailable.", { path: entry.path, error: entry.receipt.error });
    }
    result.push(entry);
  }
  return result;
}
