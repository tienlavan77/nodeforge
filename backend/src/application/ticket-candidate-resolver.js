// Resolves ticket candidate files via server-side code retrieval.
//
// The sprint leader runs as a remote text-only model with no codebase access,
// so it must never invent file paths. This resolver maps ticket text to real
// indexed files and attaches them as candidate_files after the leader returns.
import { backfillTicketCandidates } from "../modules/index/ticket-scope.js";

// Creates a resolver that maps ticket text to verified indexed files.
export function createTicketCandidateResolver({ relevantTreeSelector, clock = () => new Date(), logger = console } = {}) {
  return Object.freeze({ resolve });

  // Attaches retrieval-backed candidate_files to a ticket draft.
  async function resolve(ticket) {
    const base = ticket && typeof ticket === "object" && !Array.isArray(ticket) ? { ...ticket } : {};
    if (typeof relevantTreeSelector?.selectFreshWithEmbeddings !== "function" && typeof relevantTreeSelector?.select !== "function") {
      return backfillTicketCandidates(base, { now: () => clock().toISOString() });
    }
    try {
      const args = {
        title: base.title ?? "",
        objective: base.objective ?? "",
        acceptance_criteria: base.acceptance_criteria ?? [],
        style: base.style,
        limit: 5,
        depth: 1
      };
      const result = typeof relevantTreeSelector.selectFreshWithEmbeddings === "function"
        ? await relevantTreeSelector.selectFreshWithEmbeddings(args)
        : relevantTreeSelector.select(args);
      const tree = Array.isArray(result?.tree) ? result.tree.slice(0, 5) : [];
      if (!tree.length) return backfillTicketCandidates(base, { now: () => clock().toISOString() });
      const producedAt = clock().toISOString();
      return {
        ...base,
        candidate_files: tree.map((entry) => ({
          path: entry.path,
          role: "REFERENCE",
          reason: `retrieval:${entryReasons(entry).slice(0, 3).join(";") || "code-graph"}`
        })),
        candidates_produced_by: "retrieval",
        candidates_produced_at: producedAt
      };
    } catch (error) {
      logger.error?.("Ticket candidate retrieval failed; falling back to placeholder.", { error: error.message });
      return backfillTicketCandidates(base, { now: () => clock().toISOString() });
    }
  }
}

// Normalizes retrieval reasons which arrive as arrays, single strings, or sets.
function entryReasons(entry = {}) {
  if (Array.isArray(entry.reasons)) return entry.reasons.map(String);
  if (Array.isArray(entry.reason)) return entry.reason.map(String);
  if (typeof entry.reasons === "string" || typeof entry.reason === "string") return [String(entry.reasons ?? entry.reason)];
  if (entry.reasons instanceof Set) return [...entry.reasons].map(String);
  return [];
}
