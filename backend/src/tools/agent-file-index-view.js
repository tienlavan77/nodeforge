// Resolves live symbol windows and scopes graph metadata for safe agent file reads.
import { extractorRegistry } from "../modules/index/parser/index.js";
import { assertRoleFileAccess } from "../infrastructure/filesystem/file-service-role-policy.js";

// Finds a requested symbol against current source when indexed line ranges are stale.
export function resolveSymbolWindow(file, path, symbol) {
  const indexed = file.index_status === "fresh" ? file.code_index?.symbols?.find((entry) => entry.name === symbol) : null;
  return indexed ?? extractorRegistry.extract(path, file.content).symbols.find((entry) => entry.name === symbol) ?? null;
}

// Removes graph links outside the tool's approved paths and prefixes.
export function scopedGraph(graph, context) {
  if (!graph || !Object.keys(graph).length) return {};
  const paths = context.allowed_file_paths ?? context.allowedFilePaths ?? [];
  const prefixes = context.allowed_prefixes ?? context.allowedPrefixes ?? [];
  const allowed = (path) => {
    if (typeof path !== "string") return false;
    if (context.agent_identity?.role === "architecture_manager") {
      try { assertRoleFileAccess("architecture_manager", "read", path); return true; }
      catch (error) { if (error.code === "FILE_ROLE_FORBIDDEN") return false; throw error; }
    }
    return paths.includes(path) || prefixes.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
  };
  return { imports: (graph.imports ?? []).filter((entry) => allowed(entry.path)), imported_by: (graph.imported_by ?? []).filter((entry) => allowed(entry.path)), calls: (graph.calls ?? []).filter((entry) => allowed(entry.caller?.path) && allowed(entry.target?.path)) };
}
