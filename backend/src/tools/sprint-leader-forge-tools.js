// Gives Sprint Leader bounded, read-only Forge evidence for planning without execution authority.
import { ConfigurationError } from "../shared/errors.js";
import { assertRoleFileAccess } from "../infrastructure/filesystem/file-service-role-policy.js";
import { createOwnerConversationTools } from "./owner-conversation-tools.js";
import { createOwnerClaudeMcpTools } from "./owner-claude-mcp-tools.js";
import { createClaudeForgeOptions } from "./claude-forge-options.js";
import { sprintLeaderWebSearchOptions } from "./sprint-leader-web-search.js";

const PREFIXES = Object.freeze(["backend/", "ui/", "schemas/", "docs/", "workflows/", "scripts/", "vocabulary/"]);
const MAX_CALLS = 20;
const MAX_RESULT_BYTES = 20_000;
const MAX_TOTAL_BYTES = 120_000;

// Builds one project-scoped Forge session for a Sprint Leader SDK request.
export function createSprintLeaderForgeTools({ projectRoot, fileService, codeSearch, profile, correlationId, discoveredPaths = new Set(), projectLogger = () => {} } = {}) {
  if (!projectRoot || !fileService?.readForIndex || profile?.role !== "sprint_leader" || !profile.agent_id || !correlationId) throw new ConfigurationError("Sprint Leader Forge tools require a project, profile, and correlation ID.");
  const context = { task_id: correlationId, correlation_id: correlationId, execution_id: correlationId, project_root: projectRoot, allowed_prefixes: [...PREFIXES], agent_identity: { agent_id: profile.agent_id, agent_name: profile.agent_name, role: "sprint_leader", provider: profile.provider }, context_budget: { max_calls: MAX_CALLS, max_bytes: MAX_TOTAL_BYTES, used_calls: 0, used_bytes: 0 } };
  const base = createOwnerConversationTools({ role: "sprint_leader", projectRoot, fileService, codeSearch, projectLogger, context });
  const definitions = base.definitions.filter(({ name }) => ["search_tree", "list_files", "search_text", "read_file", "read_lines"].includes(name));
  if (definitions.length !== 5) throw new ConfigurationError("Sprint Leader read tools are unavailable.");
  context.capabilities = definitions.map(({ name }) => name);
  let calls = 0;
  let outputBytes = 0;
  const registry = Object.fromEntries(definitions.map(({ name }) => [name, { execute: async (input) => {
    if (calls >= MAX_CALLS) throw fail("SPRINT_LEADER_TOOL_BUDGET", "Sprint Leader read call budget is exhausted.");
    calls += 1;
    const bounded = name === "search_tree" ? { ...input, max_depth: Math.min(input?.max_depth ?? 3, 3), limit: Math.min(input?.limit ?? 80, 80) } : input;
    const result = await base.registry[name].execute(bounded, context);
    if (name === "search_tree") {
      result.entries = result.entries.filter((entry) => PREFIXES.some((prefix) => entry.path === prefix.slice(0, -1) || entry.path.startsWith(prefix)));
      result.total = result.entries.length;
    }
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (bytes > MAX_RESULT_BYTES || outputBytes + bytes > MAX_TOTAL_BYTES) throw fail("SPRINT_LEADER_TOOL_BUDGET", "Sprint Leader read output budget is exhausted.");
    outputBytes += bytes;
    if (name === "search_text") recordSearchPaths(result.stdout, discoveredPaths);
    if (name === "search_tree") for (const entry of result.entries) if (entry.type === "file" && typeof entry.path === "string") discoveredPaths.add(entry.path);
    if (name === "read_file" && typeof result.path === "string") discoveredPaths.add(result.path);
    if (name === "read_lines" && result.exit_code === 0) discoveredPaths.add(input.path);
    if (name === "list_files") for (const path of result.stdout.split("\n").filter(Boolean)) discoveredPaths.add(path);
    projectLogger({ timestamp: new Date().toISOString(), event_name: "sprint_leader.tool_call", level: "info", status: "success", message: `Sprint Leader used ${name}.`, task_id: correlationId, correlation_id: correlationId, source: "sprint-leader-forge-tools", payload: { agent_id: profile.agent_id, tool: name, output_bytes: bytes } });
    return result;
  } }]));
  return { definitions, registry, context };
}

/** Records search evidence for planning by separating ripgrep file prefixes from
 * line coordinates and match content, retaining only role-authorized project paths. */
function recordSearchPaths(stdout, discoveredPaths) {
  for (const line of (stdout ?? "").split("\n")) {
    const path = line.match(/^([^:]+):/)?.[1];
    if (!path || !PREFIXES.some((prefix) => path.startsWith(prefix)) || path.split("/").includes("..")) continue;
    try { assertRoleFileAccess("sprint_leader", "read", path); discoveredPaths.add(path); }
    catch (error) { if (error.code !== "FILE_ROLE_FORBIDDEN") throw error; }
  }
}

// Selects provider-specific SDK options while preserving the same read-only Forge registry.
export function createSprintLeaderToolOptions({ profile, ...dependencies }) {
  const forgeTools = createSprintLeaderForgeTools({ profile, ...dependencies });
  const search = sprintLeaderWebSearchOptions(profile);
  if (["claude", "anthropic"].includes(profile.provider)) {
    const claude = createOwnerClaudeMcpTools(forgeTools);
    return { ...createClaudeForgeOptions({ ...claude, allowedTools: [...claude.allowedTools, ...(search.tools ?? [])] }), ...search };
  }
  if (["codex", "openai"].includes(profile.provider)) return { forgeTools, sandboxMode: "read-only", approvalPolicy: "on-request", networkAccessEnabled: false, webSearchMode: "disabled", ...search };
  throw fail("SPRINT_LEADER_PROVIDER_UNSUPPORTED", `Sprint Leader provider is unsupported: ${profile.provider}.`);
}

// Reports planning tool policy failures without executing the requested tool.
function fail(code, message) { return Object.assign(new ConfigurationError(message), { code, statusCode: 409 }); }
