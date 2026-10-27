// Names the shared engineering contract and preserves equivalent historical checkpoint identities.
export const ENGINEERING_CATALOG_VERSION = "forge-engineering-v2";
export const ENGINEERING_TOOL_NAMES = Object.freeze(["search_tree", "list_files", "search_text", "read_file", "read_lines", "write_diff", "edit_diff", "delete_file", "move_file", "git_status", "git_diff", "run_check", "commit_changes", "push_commit", "lookup_schema"]);
export const CODER_TOOL_NAMES = Object.freeze([...ENGINEERING_TOOL_NAMES, "report_done", "respond_to_review", "query_review"]);
export const ENGINEERING_ALIASES = Object.freeze({ rg_files: "list_files", rg_search: "search_text", sed_lines: "read_lines" });

// Normalizes schema-equivalent legacy names without relabeling semantic search as a text search.
export function engineeringToolName(name) {
  return ENGINEERING_ALIASES[name] ?? name;
}
