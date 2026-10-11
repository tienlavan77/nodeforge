// Configures direct System Engineer SDK tools and publishes their activity without Forge mutation receipts.
import { lstat, realpath } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { ConfigurationError } from "../shared/errors.js";

const CLAUDE_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebSearch"];
const SYSTEM_READ_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/ld.so.cache", "/dev/null", "/dev/urandom"];

// Denies host data without masking merged-/usr library symlinks needed to run project checks.
function claudeReadDenyPaths(projectRoot) {
  const systemRoots = new Set(SYSTEM_READ_PATHS.filter((path) => path.split("/").length === 2));
  return readdirSync("/").map((name) => `/${name}`).filter((path) => !systemRoots.has(path) && path !== projectRoot);
}

// Pins resumed execution to its original tool mode and rejects unsupported direct SDKs.
export function ownerToolMode(profile, checkpoint, continuing) {
  const mode = continuing ? checkpoint?.tool_mode ?? "forge" : profile.tool_mode ?? "forge";
  if (!["forge", "builtin"].includes(mode)) throw new ConfigurationError("Unknown owner tool mode.");
  if (mode === "builtin" && (profile.role !== "system_engineer" || !["codex", "claude", "anthropic"].includes(profile.provider))) throw new ConfigurationError("Built-in mode requires a Codex or Claude System Engineer.");
  return mode;
}

// Enforces project-only native file access, including existing symlink components.
export async function assertBuiltinFilePath(projectRoot, path) {
  const root = await realpath(projectRoot);
  const target = resolve(root, path ?? ".");
  const inside = (value) => { const part = relative(root, value); return part !== ".." && !part.startsWith("../") && !part.startsWith("/"); };
  if (!inside(target)) throw new ConfigurationError("Built-in file access must stay in the project.");
  let current = target;
  while (inside(current)) {
    try { await lstat(current); if (!inside(await realpath(current))) throw new ConfigurationError("Built-in path escapes through a symlink."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (current === root) break;
    current = dirname(current);
  }
}

// Enables SDK tools without a Forge MCP server and keeps shell execution sandboxed.
export function ownerBuiltinOptions(profile, projectRoot) {
  if (profile.provider === "codex") {
    const entries = [`":root"="deny"`, ...SYSTEM_READ_PATHS.map((path) => `${JSON.stringify(path)}="read"`), `${JSON.stringify(projectRoot)}="write"`];
    return { usePermissionProfile: true, sandboxMode: undefined, networkAccessEnabled: undefined, approvalPolicy: "never", webSearchMode: "live",
      config: { default_permissions: "engineer" }, configOverrides: [`permissions.engineer.filesystem={${entries.join(",")}}`, "permissions.engineer.network.enabled=true"] };
  }
  // Applies the path guard even when an SDK allowlist would bypass canUseTool.
  const guard = async (input) => {
    try {
      if (!CLAUDE_TOOLS.includes(input.tool_name)) throw new ConfigurationError("Tool is not enabled for direct engineering.");
      const args = input.tool_input ?? {};
      if (input.tool_name === "Bash") {
        if (args.dangerouslyDisableSandbox || args.run_in_background) throw new ConfigurationError("Native shell must run synchronously inside the sandbox.");
      } else if (input.tool_name !== "WebSearch") {
        await assertBuiltinFilePath(projectRoot, args.file_path ?? args.path ?? ".");
      }
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
    } catch (error) { return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: error.message } }; }
  };
  return { tools: [...CLAUDE_TOOLS], allowedTools: [...CLAUDE_TOOLS], mcpServers: {}, settingSources: [], permissionMode: "default",
    hooks: { PreToolUse: [{ hooks: [guard] }] },
    sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, network: { allowedDomains: ["*"] },
      filesystem: { denyRead: claudeReadDenyPaths(projectRoot), allowRead: [projectRoot, ...SYSTEM_READ_PATHS], allowWrite: [projectRoot] } } };
}

// Converts native SDK tool boundaries into the existing UI activity and terminal log contract.
export function emitOwnerBuiltinActivity({ profile, conversationId, correlationId, eventSink, projectLogger }, event) {
  const status = event.status;
  const summary = `SDK ${event.tool} ${status}${Number.isInteger(event.exit_code) ? ` (exit=${event.exit_code})` : ""}${event.command ? `: ${event.command.slice(0, 240)}` : event.path ? `: ${event.path.slice(0, 240)}` : ""}`;
  const timestamp = new Date().toISOString();
  const payload = { agent_id: profile.agent_id, agent_name: profile.agent_name, provider: profile.provider, conversation_id: conversationId, correlation_id: correlationId,
    activity_type: status === "started" ? "tool_started" : status === "failed" ? "tool_failed" : "tool_completed", status: status === "started" ? "working" : status === "failed" ? "failed" : "success", summary, tool_name: event.tool };
  eventSink?.({ event_type: "agent.activity", timestamp, task_id: correlationId, conversation_id: conversationId, correlation_id: correlationId, payload });
  projectLogger?.({ timestamp, event_name: "owner.tool_call", level: status === "failed" ? "error" : "info", status, message: summary, task_id: correlationId, conversation_id: conversationId, correlation_id: correlationId,
    source: "owner-sdk-builtin", payload: { ...payload, tool: event.tool, result: { exit_code: event.exit_code, result_bytes: event.result_bytes } } });
}

// Maps Codex native command and edit items into provider-neutral activity boundaries.
export function codexBuiltinActivity(event) {
  if (!["item.started", "item.completed"].includes(event.type)) return null;
  const item = event.item;
  if (!["command_execution", "file_change", "web_search"].includes(item?.type)) return null;
  return { tool: item.type, status: event.type === "item.started" ? "started" : item.status === "failed" || item.exit_code > 0 ? "failed" : "success", command: item.command,
    exit_code: item.exit_code, result_bytes: typeof item.aggregated_output === "string" ? Buffer.byteLength(item.aggregated_output) : undefined };
}
