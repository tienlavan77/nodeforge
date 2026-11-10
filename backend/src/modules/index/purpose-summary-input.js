// Defines the derived-processing contract for stored O1 summaries. Keeping content separate
// from the versioned checksum prevents implementation and metadata from reaching providers.
import { createHash } from "node:crypto";

/** Returns complete stored summary content and a contract-specific identity, or no input
 * when purpose documentation is absent. The version invalidates legacy code-derived data. */
export function purposeSummaryInput(summaryOrMeta, meta = {}) {
  const isObject = Boolean(summaryOrMeta && typeof summaryOrMeta === "object" && !Array.isArray(summaryOrMeta));
  const summary = isObject ? summaryOrMeta.summary : summaryOrMeta;
  if (typeof summary !== "string" || !summary.trim()) return null;
  const ctx = isObject ? summaryOrMeta : meta;
  const filePath = typeof ctx?.path === "string" && ctx.path.trim() ? ctx.path.trim() : typeof ctx?.filePath === "string" && ctx.filePath.trim() ? ctx.filePath.trim() : "";
  const symbolName = typeof ctx?.name === "string" && ctx.name.trim() ? ctx.name.trim() : typeof ctx?.symbolName === "string" && ctx.symbolName.trim() ? ctx.symbolName.trim() : "";
  const symbolKind = typeof ctx?.kind === "string" && ctx.kind.trim() ? ctx.kind.trim() : typeof ctx?.symbolKind === "string" && ctx.symbolKind.trim() ? ctx.symbolKind.trim() : "symbol";
  const content = filePath && symbolName ? `[${filePath} :: ${symbolName} (${symbolKind})] ${summary}` : summary;
  return {
    content,
    checksum: `purpose-summary-v2:sha256:${createHash("sha256").update(content).digest("hex")}`
  };
}
