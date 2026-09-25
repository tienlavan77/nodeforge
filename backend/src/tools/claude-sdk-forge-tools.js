// Summary: Adapts Forge tool definitions to Claude Agent SDK MCP servers with Zod-validated inputs.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const searchCodeInput = {
  query: z.string().min(1),
  kind: z.enum(["file", "symbol", "content"]).optional(),
  limit: z.number().int().positive().max(50).optional(),
  allowed_prefixes: z.array(z.string().min(1)).min(1),
  projection: z.enum(["minimal", "summary", "graph"]).optional()
};

const readFileInput = {
  path: z.string().min(1),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(500).optional()
};

const selectCodeGraphCandidatesInput = {
  query: z.string().min(1),
  context: z.string().max(1000).optional(),
  limit: z.number().int().positive().max(8).optional()
};

const writeDiffInput = {
  path: z.string().min(1),
  content: z.string(),
  before_checksum: z.string().nullable()
};

const editDiffInput = {
  path: z.string().min(1),
  before_checksum: z.string().nullable(),
  anchor: z.string().min(1),
  replacement: z.string(),
  occurrence: z.enum(["first", "all"]).optional()
};

const runTestInput = {};

const checkTestInput = {
  job_id: z.string().min(1)
};

const commitChangesInput = {
  message: z.string().trim().min(1).max(200)
};

const reportDoneInput = {
  summary: z.string().trim().min(1).max(4000)
};

// Input defaults live here rather than in zod .default(): the Claude Agent SDK
// bundles its own zod4 validation that treats zod-defaulted fields as required
// (optin "defaulted" fails the nonoptional check), so an omitted optional
// argument like select_code_graph_candidates.limit threw MCP error -32602.
const INPUT_DEFAULTS = Object.freeze({
  select_code_graph_candidates: Object.freeze({ limit: 8 }),
  search_code: Object.freeze({ kind: "file", limit: 10, projection: "minimal" }),
  edit_diff: Object.freeze({ occurrence: "first" })
});

export function createForgeSdkMcpServer({ registry, context = {}, includeCommit = false } = {}) {
  if (!registry || typeof registry !== "object") throw new TypeError("Forge SDK MCP server requires a tool registry.");

  const definitions = [
    ["select_code_graph_candidates", "Ask Node to find up to eight candidate files related to your search intent, with import relations. Call this FIRST as your project map before searching or reading.", selectCodeGraphCandidatesInput],
    ["search_code", "Search the approved project code index. kind=\"content\" returns FTS text snippets with matching lines; kind=\"file\" with projection=\"summary\" returns a file's symbol map with line ranges.", searchCodeInput],
    ["read_file", "Read one approved project file. Use offset/limit windows (max 500 lines) instead of reading whole files.", readFileInput],
    ["write_diff", "Write one approved project file after checksum validation. Content is capped at 8 KB. For a new file that does not exist, before_checksum must be the JSON value null (not a string and not omitted).", writeDiffInput],
    ["edit_diff", "Replace an exact anchor string in one approved file after checksum validation. Read the file first and use a unique exact anchor; use occurrence=\"all\" to replace every match.", editDiffInput],
    ["run_test", "Start the Node-owned test suite and return a job_id immediately. You MUST then call check_test with that job_id repeatedly until status is passed or failed before reporting done.", runTestInput],
    ["check_test", "Poll a started test job by job_id until it reports passed or failed.", checkTestInput],
    ["git_status", "Read the project working-tree status through Node Git Service.", {}],
    ["git_diff", "Read the unstaged project patch through Node Git Service.", {}],
    ...(includeCommit ? [["commit_changes", "Commit approved changed files.", commitChangesInput]] : []),
    ["report_done", "Record the final task report.", reportDoneInput]
  ];

  const tools = definitions
    .filter(([name]) => typeof registry[name]?.execute === "function")
    .map(([name, description, inputSchema]) => tool(name, description, inputSchema, async (input) => {
      const normalizedInput = {
        ...(INPUT_DEFAULTS[name] ?? {}),
        ...input,
        ...(name === "write_diff" && input?.before_checksum === "null" ? { before_checksum: null } : {})
      };
      try {
        const result = await registry[name].execute(normalizedInput, context);
        return { content: [{ type: "text", text: JSON.stringify(result ?? null) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: JSON.stringify({
              error_code: error.code ?? "TOOL_EXECUTION_FAILED",
              message: error.message,
              ...(error.details ? { details: error.details } : {})
            })
          }]
        };
      }
    }));

  return createSdkMcpServer({ name: "forge", version: "1.0.0", tools, alwaysLoad: true });
}

export const forgeSdkToolNames = Object.freeze([
  "mcp__forge__select_code_graph_candidates",
  "mcp__forge__search_code",
  "mcp__forge__read_file",
  "mcp__forge__write_diff",
  "mcp__forge__edit_diff",
  "mcp__forge__run_test",
  "mcp__forge__check_test",
  "mcp__forge__git_status",
  "mcp__forge__git_diff",
  "mcp__forge__commit_changes",
  "mcp__forge__report_done"
]);
