// Defines the derived-processing contract for stored O1 summaries. Keeping content separate
// from the versioned checksum prevents implementation and metadata from reaching providers.
import { createHash } from "node:crypto";

/** Returns complete stored summary content and a contract-specific identity, or no input
 * when purpose documentation is absent. The version invalidates legacy code-derived data. */
export function purposeSummaryInput(summary) {
  if (typeof summary !== "string" || !summary.trim()) return null;
  return {
    content: summary,
    checksum: `purpose-summary-v1:sha256:${createHash("sha256").update(summary).digest("hex")}`
  };
}
