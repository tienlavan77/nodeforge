// Counts returned records so Forge can log discovery results without source content.
// Summarizes Claude and Forge discovery results for operator status and project logs.
export function resultCount(name, result) {
  if (!result || typeof result !== "object") return undefined;
  if (["Glob", "Grep"].includes(name)) return result.total ?? (name === "Glob" ? result.files?.length : result.matches?.length);
  if (name === "Read") return result.total_lines;
  if (name === "select_code_graph_candidates" && Array.isArray(result.selected)) return result.selected.length;
  if (name === "search_code" && Array.isArray(result.matches)) return result.matches.length;
  return undefined;
}
