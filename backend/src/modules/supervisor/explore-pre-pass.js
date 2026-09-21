// Resolves exact target files for a ticket before the coder runs.
// Read-only: uses the code index (FTS + graph), never edits files or calls SDK.
import { ConfigurationError } from "../../shared/errors.js";
import { extractExplicitPaths, resolveDependencyFiles } from "../index/ticket-scope.js";

const PROJECT_MAP = Object.freeze({
  frontend: ["ui/nextjs/", "ui/src/", "web/src/"],
  backend: ["backend/src/", "schemas/"],
  contracts: ["schemas/"]
});

// Runs the structure-aware pre-pass: FTS candidates filtered by ticket.style,
// confirmed via import graph, returning exact targets for the coder.
export function createExplorePrepass({ relevantTreeSelector, fileGraph, protocolStorage } = {}) {
  if (typeof relevantTreeSelector?.select !== "function") throw new ConfigurationError("Explore pre-pass requires Relevant Tree selector.");
  return Object.freeze({ run });

  async function run({ ticket, limit = 4 } = {}) {
    if (!ticket || typeof ticket !== "object") throw new ConfigurationError("Explore pre-pass requires a ticket.");
    const started = Date.now();
    try {
      const dependencyFiles = await resolveDependencyFiles(ticket, { protocolStorage }).catch(() => []);
      const explicitPaths = extractExplicitPaths(ticket);
      const args = {
        title: ticket.title ?? "",
        objective: ticket.objective ?? "",
        acceptance_criteria: ticket.acceptance_criteria ?? [],
        style: ticket.style,
        limit,
        depth: 1,
        priorFiles: explicitPaths,
        dependencyFiles
      };
      const result = typeof relevantTreeSelector.selectFresh === "function"
        ? await relevantTreeSelector.selectFresh(args)
        : relevantTreeSelector.select(args);
      const tree = Array.isArray(result.tree) ? result.tree : [];
      const targetFiles = tree.map((entry) => entry.path).filter(Boolean);
      const targetPath = pickTargetPath(targetFiles, ticket);
      const stalePaths = Array.isArray(result.stale_paths) ? result.stale_paths : [];
      return {
        targetFiles,
        targetPath,
        allowedPrefixes: result.allowed_prefixes ?? [],
        indexVersion: result.index_version ?? null,
        confidence: !targetFiles.length ? "low" : stalePaths.includes(targetPath) ? "medium" : "high",
        reason: !targetFiles.length ? "no code-index match" : stalePaths.includes(targetPath) ? "code-index match, target needs verify (stale)" : "code-index match",
        ...(stalePaths.length ? { stalePaths, freshness: result.freshness ?? null } : {}),
        durationMs: Date.now() - started
      };
    } catch (error) {
      return { targetFiles: [], targetPath: null, allowedPrefixes: [], confidence: "low", reason: `explore_prepass_failed: ${error.message}`, durationMs: Date.now() - started };
    }
  }

  function pickTargetPath(files, ticket) {
    if (!files.length) return null;
    // Prefer an explicit path named in the ticket text.
    const candidates = [ticket?.objective, ...(ticket?.acceptance_criteria ?? [])];
    for (const text of candidates) {
      if (typeof text !== "string") continue;
      for (const file of files) {
        if (text.includes(file)) return file;
      }
    }
    return files[0] ?? null;
  }
}

export { PROJECT_MAP };
