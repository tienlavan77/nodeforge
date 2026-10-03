// Gives Sprint Leader bounded, read-only Forge evidence for planning without execution authority.
import { ConfigurationError } from "../shared/errors.js";
import { assertRoleFileAccess } from "../infrastructure/filesystem/file-service-role-policy.js";
import { createOwnerConversationTools } from "./owner-conversation-tools.js";
import { createSearchCodeTool } from "./search-code.js";
import { searchCodeDefinition } from "./index.js";
import { createOwnerClaudeMcpTools } from "./owner-claude-mcp-tools.js";
import { createClaudeForgeOptions } from "./claude-forge-options.js";

const PREFIXES = Object.freeze(["backend/", "ui/", "schemas/", "docs/", "workflows/", "scripts/", "vocabulary/"]);
const MAX_CALLS = 20;
const MAX_RESULT_BYTES = 20_000;
const MAX_TOTAL_BYTES = 120_000;
const SEARCH_DEFINITION = Object.freeze({ ...searchCodeDefinition, description: "Search the existing project code index for planning evidence; Node fixes the permitted paths and result limit.", input_schema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 200 }, kind: { type: "string", enum: ["file", "symbol", "content"] }, limit: { type: "integer", minimum: 1, maximum: 10 }, projection: { type: "string", enum: ["minimal", "summary", "graph"] } } } });

// Builds one project-scoped Forge session for a Sprint Leader SDK request.
export function createSprintLeaderForgeTools({ projectRoot, fileService, codeSearch, profile, correlationId, projectLogger = () => {} } = {}) {
  if (!projectRoot || !fileService?.readForIndex || !codeSearch?.search || profile?.role !== "sprint_leader" || !profile.agent_id || !correlationId) throw new ConfigurationError("Sprint Leader Forge tools require a project, code index, profile, and correlation ID.");
  const context = { task_id: correlationId, correlation_id: correlationId, execution_id: correlationId, project_root: projectRoot, allowed_prefixes: [...PREFIXES], agent_identity: { agent_id: profile.agent_id, agent_name: profile.agent_name, role: "sprint_leader", provider: profile.provider }, context_budget: { max_calls: MAX_CALLS, max_bytes: MAX_TOTAL_BYTES, used_calls: 0, used_bytes: 0 } };
  const base = createOwnerConversationTools({ role: "sprint_leader", projectRoot, fileService, codeSearch, projectLogger, context });
  const selected = base.definitions.filter(({ name }) => name === "search_tree" || name === "read_file");
  if (selected.length !== 2) throw new ConfigurationError("Sprint Leader read tools are unavailable.");
  const codeTool = createSearchCodeTool({ codeSearch, projectLogger });
  const definitions = [...selected, SEARCH_DEFINITION];
  context.capabilities = definitions.map(({ name }) => name);
  let calls = 0;
  let outputBytes = 0;
  const implementations = { ...base.registry, search_code: { execute: (input) => codeTool.execute({ query: input.query, kind: input.kind ?? "file", limit: input.limit ?? 8, projection: input.projection ?? "summary", allowed_prefixes: [...PREFIXES] }, context) } };
  const registry = Object.fromEntries(definitions.map(({ name }) => [name, { execute: async (input) => {
    if (calls >= MAX_CALLS) throw fail("SPRINT_LEADER_TOOL_BUDGET", "Sprint Leader read call budget is exhausted.");
    calls += 1;
    const bounded = name === "search_tree" ? { ...input, max_depth: Math.min(input?.max_depth ?? 3, 3), limit: Math.min(input?.limit ?? 80, 80) } : input;
    const result = await implementations[name].execute(bounded, context);
    if (name === "search_code") result.matches = result.matches.filter((match) => { try { assertRoleFileAccess("sprint_leader", "read", match.path); return true; } catch (error) { if (error.code !== "FILE_ROLE_FORBIDDEN") throw error; return false; } });
    if (name === "search_tree") {
      result.entries = result.entries.filter((entry) => PREFIXES.some((prefix) => entry.path === prefix.slice(0, -1) || entry.path.startsWith(prefix)));
      result.total = result.entries.length;
    }
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (bytes > MAX_RESULT_BYTES || outputBytes + bytes > MAX_TOTAL_BYTES) throw fail("SPRINT_LEADER_TOOL_BUDGET", "Sprint Leader read output budget is exhausted.");
    outputBytes += bytes;
    projectLogger({ event_name: "sprint_leader.tool_call", level: "info", status: "success", message: `Sprint Leader used ${name}.`, task_id: correlationId, correlation_id: correlationId, source: "sprint-leader-forge-tools", payload: { agent_id: profile.agent_id, tool: name, output_bytes: bytes } });
    return result;
  } }]));
  return { definitions, registry, context };
}

// Selects provider-specific SDK options while preserving the same read-only Forge registry.
export function createSprintLeaderToolOptions({ profile, ...dependencies }) {
  const forgeTools = createSprintLeaderForgeTools({ profile, ...dependencies });
  if (["claude", "anthropic"].includes(profile.provider)) return createClaudeForgeOptions(createOwnerClaudeMcpTools(forgeTools));
  if (["codex", "openai"].includes(profile.provider)) return { forgeTools, sandboxMode: "read-only", approvalPolicy: "on-request", networkAccessEnabled: false, webSearchMode: "disabled" };
  throw fail("SPRINT_LEADER_PROVIDER_UNSUPPORTED", `Sprint Leader provider is unsupported: ${profile.provider}.`);
}

// Reports planning tool policy failures without executing the requested tool.
function fail(code, message) { return Object.assign(new ConfigurationError(message), { code, statusCode: 409 }); }
