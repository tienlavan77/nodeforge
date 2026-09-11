import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const searchCodeInput = {
  query: z.string().min(1),
  kind: z.enum(["file", "symbol"]).default("file"),
  limit: z.number().int().positive().max(50).default(10),
  allowed_prefixes: z.array(z.string().min(1)).min(1)
};

const readFileInput = {
  path: z.string().min(1)
};

const writeDiffInput = {
  path: z.string().min(1),
  content: z.string(),
  before_checksum: z.string().nullable()
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

export function createForgeSdkMcpServer({ registry, context = {}, includeCommit = false } = {}) {
  if (!registry || typeof registry !== "object") throw new TypeError("Forge SDK MCP server requires a tool registry.");

  const definitions = [
    ["search_code", "Search the approved project code index.", searchCodeInput],
    ["read_file", "Read one approved project file.", readFileInput],
    ["write_diff", "Write one approved project file after checksum validation. For a new file that does not exist, before_checksum must be the JSON value null (not a string and not omitted).", writeDiffInput],
    ["run_test", "Start the Node-owned test suite and return a job_id immediately. You MUST then call check_test with that job_id repeatedly until status is passed or failed before reporting done.", runTestInput],
    ["check_test", "Poll a started test job by job_id until it reports passed or failed.", checkTestInput],
    ...(includeCommit ? [["commit_changes", "Commit approved changed files.", commitChangesInput]] : []),
    ["report_done", "Record the final task report.", reportDoneInput]
  ];

  const tools = definitions
    .filter(([name]) => typeof registry[name]?.execute === "function")
    .map(([name, description, inputSchema]) => tool(name, description, inputSchema, async (input) => {
      const normalizedInput = name === "write_diff" && input?.before_checksum === "null"
        ? { ...input, before_checksum: null }
        : input;
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
  "mcp__forge__search_code",
  "mcp__forge__read_file",
  "mcp__forge__write_diff",
  "mcp__forge__run_test",
  "mcp__forge__check_test",
  "mcp__forge__commit_changes",
  "mcp__forge__report_done"
]);
