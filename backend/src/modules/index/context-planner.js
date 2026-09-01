import { ConfigurationError } from "../../shared/errors.js";

/** Materialize a bounded relevant tree into fresh, checksum-verified context. */
export function createContextPlanner({ fileService, database, maxFiles = 30, maxTokens = 12000 } = {}) {
  if (!fileService || typeof fileService.readForIndex !== "function") throw new ConfigurationError("Context Planner requires File Service readForIndex.");
  if (!database || typeof database.all !== "function") throw new ConfigurationError("Context Planner requires an index database.");
  return Object.freeze({ plan });

  async function plan({ relevantTree = [], files = relevantTree, limit = maxFiles, tokenBudget = maxTokens } = {}) {
    if (!Array.isArray(files) || files.length === 0) throw new ConfigurationError("Context Planner requires a relevant tree.");
    if (!Number.isInteger(limit) || limit < 1 || limit > maxFiles) throw new ConfigurationError(`Context Planner limit must be between 1 and ${maxFiles}.`);
    if (!Number.isInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > maxTokens) throw new ConfigurationError(`Context Planner token budget must be between 1 and ${maxTokens}.`);
    const selected = files.slice(0, limit);
    const contextFiles = [];
    let estimatedTokens = 0;
    for (const entry of selected) {
      const path = typeof entry === "string" ? entry : entry?.path;
      if (!path) throw new ConfigurationError("Context Planner tree entries require a path.");
      const indexed = database.all("SELECT file_id, path, language, sha256, size_bytes FROM files WHERE path = ?", [path])[0];
      if (!indexed) throw new ConfigurationError(`Indexed file not found: ${path}`);
      const current = await fileService.readForIndex({ path });
      if (indexed.sha256 && normalizeHash(indexed.sha256) !== normalizeHash(current.sha256)) {
        const error = new ConfigurationError(`Indexed content is stale for ${path}.`);
        error.code = "CONTEXT_STALE";
        error.path = path;
        throw error;
      }
      const tokens = Math.ceil(current.content.length / 4);
      if (estimatedTokens + tokens > tokenBudget) {
        if (contextFiles.length === 0) throw new ConfigurationError(`Context Planner token budget exceeded for ${path}.`);
        break;
      }
      estimatedTokens += tokens;
      contextFiles.push({ path, language: current.language ?? indexed.language ?? null, content: current.content, sha256: current.sha256, size_bytes: current.size_bytes, reason: entry?.reason ?? "relevant tree match", score: entry?.score ?? null });
    }
    return Object.freeze({ files: Object.freeze(contextFiles), index_version: indexVersion(), budget: { max_tokens: tokenBudget, estimated_tokens: estimatedTokens, max_files: limit }, source: "file-service" });
  }

  function normalizeHash(value) { return String(value).replace(/^sha256:/, ""); }
  function indexVersion() { return `IDX-${database.all("SELECT version FROM index_metadata LIMIT 1")[0]?.version ?? 0}`; }
}
