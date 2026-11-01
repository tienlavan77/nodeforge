// Business purpose: enforces NodeForge MCP tool usage across both Claude CLI and Codex CLI `PreToolUse` hooks so native file reads, searches, patches, and shell mutations cannot bypass SHA-256 receipt tracking.
// Technical description: reads optional JSON hook payloads from stdin, evaluates native tool names and shell commands against Forge routing rules, and formats a cross-CLI `PreToolUse` decision payload.

const DEFAULT_DENY_REASON = "Use the corresponding mcp__forge__ discovery or mutation tool to preserve SHA-256 receipts; call context_digest after compaction.";

const TOOL_GUIDANCE_MAP = Object.freeze({
  Read: "Use mcp__forge__read_file (metadata/symbol_map) and mcp__forge__Read (symbol-scoped code or bounded .md window) instead of native Read.",
  read_file: "Use mcp__forge__read_file and mcp__forge__Read instead of native read_file to preserve SHA-256 receipts.",
  Grep: "Use mcp__forge__search_text instead of native Grep to search project file contents safely.",
  Glob: "Use mcp__forge__list_files or mcp__forge__search_tree instead of native Glob.",
  list_dir: "Use mcp__forge__search_tree or mcp__forge__list_files instead of native list_dir.",
  Edit: "Use mcp__forge__edit_diff with before_checksum instead of native Edit to preserve SHA-256 receipts.",
  edit_file: "Use mcp__forge__edit_diff with before_checksum instead of native edit_file to preserve SHA-256 receipts.",
  MultiEdit: "Use mcp__forge__edit_diff with before_checksum instead of native MultiEdit to preserve SHA-256 receipts.",
  Write: "Use mcp__forge__write_diff or mcp__forge__edit_diff with before_checksum instead of native Write.",
  write_file: "Use mcp__forge__write_diff or mcp__forge__edit_diff with before_checksum instead of native write_file.",
  NotebookEdit: "Use mcp__forge__edit_diff or mcp__forge__write_diff instead of native NotebookEdit.",
  apply_patch: "Use mcp__forge__edit_diff or mcp__forge__write_diff with before_checksum instead of native apply_patch to preserve SHA-256 receipts."
});

const SHELL_TOOL_NAMES = new Set(["Bash", "shell", "exec_command", "bash", "command_execution", "container.exec", "local_shell"]);

const SAFE_SHELL_PREFIXES = [
  /^\s*(?:[\w]+=\S+\s+)*(?:node\s+--test|npm\s+(?:test|run\s+(?:test|lint|build|typecheck|check))|npx\s+(?:tsc|eslint|vitest|jest|playwright)|pnpm\s+(?:test|lint|build|typecheck)|yarn\s+(?:test|lint|build|typecheck)|pytest|cargo\s+(?:test|check|clippy|build)|go\s+(?:test|vet|build)|mvn\s+(?:test|compile)|gradle\s+(?:test|check))\b/i,
  /^\s*(?:uname|whoami|pwd|date|which|command\s+-v|node\s+-v|npm\s+-v|git\s+(?:status|diff|log|branch|rev-parse|show))\b/i
];

const SHELL_MUTATION_PATTERNS = [
  { pattern: /\b(?:sed\s+-i|perl\s+-i|awk\s+-i\s+inplace|patch\b|git\s+apply\b)/, guidance: "Use mcp__forge__edit_diff or mcp__forge__write_diff instead of mutating project files via shell." },
  { pattern: /\b(?:tee|cp|mv|dd|install|truncate)\b/, guidance: "Use mcp__forge__write_diff, mcp__forge__edit_diff, or mcp__forge__move_file instead of shell file writes/moves." },
  { pattern: /\brm\b/, guidance: "Use mcp__forge__delete_file with before_checksum instead of deleting project files via rm." },
  { pattern: /(?:^|[^0-9<>])>>?\s*(?!\/dev\/null\b|&\d)[^\s;|&]+/, guidance: "Use mcp__forge__write_diff or mcp__forge__edit_diff instead of shell output redirection to files." },
  { pattern: /\b(?:cat|head|tail|less|more|nl|bat|sed|awk)\b/, guidance: "Use mcp__forge__read_file and mcp__forge__Read instead of reading project files via shell." },
  { pattern: /\b(?:grep|rg|ripgrep|ag|ack|find|fd)\b/, guidance: "Use mcp__forge__search_text, mcp__forge__list_files, or mcp__forge__search_tree instead of shell file search." }
];

// Business purpose: builds a standardized `PreToolUse` hook response compatible with both Claude CLI and Codex CLI JSON hook parsers.
// Technical description: returns `decision` (`allow` or `block`), `reason`, and `hookSpecificOutput` containing `hookEventName`, `permissionDecision`, and `permissionDecisionReason`.
export function buildPreToolHookResponse(permissionDecision, reason) {
  const isDeny = permissionDecision === "deny";
  return {
    decision: isDeny ? "block" : "allow",
    ...(isDeny && reason ? { reason } : {}),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: isDeny ? "deny" : "allow",
      ...(reason ? { permissionDecisionReason: reason } : {})
    }
  };
}

// Business purpose: extracts the shell command string from a Claude or Codex shell tool invocation payload.
// Technical description: inspects `command`, `cmd`, `script`, or array-based `command` fields inside `tool_input` or top-level payload properties.
function extractShellCommand(payload) {
  const input = (payload?.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : null)
    ?? (payload?.input && typeof payload.input === "object" ? payload.input : null)
    ?? payload ?? {};
  const rawCmd = input.command ?? input.cmd ?? input.script ?? payload?.command ?? "";
  if (Array.isArray(rawCmd)) return rawCmd.join(" ");
  return typeof rawCmd === "string" ? rawCmd.trim() : "";
}

// Business purpose: evaluates whether a shell command attempts direct source file reading, searching, or mutation versus allowed test/build/system checks.
// Technical description: checks the command against `SHELL_MUTATION_PATTERNS` and `SAFE_SHELL_PREFIXES` and returns a deny reason when direct file manipulation is detected.
function evaluateShellCommand(command) {
  if (!command) {
    return "Shell tool invocation without an explicit safe test/build command is blocked; use mcp__forge__run_check or mcp__forge__* tools.";
  }
  const hasRedirectionToFile = /(?:^|[^0-9<>])>>?\s*(?!\/dev\/null\b|&\d)[^\s;|&]+/.test(command);
  if (!hasRedirectionToFile && SAFE_SHELL_PREFIXES.some((regex) => regex.test(command))) {
    return null;
  }
  for (const { pattern, guidance } of SHELL_MUTATION_PATTERNS) {
    if (pattern.test(command)) {
      return `${guidance} Call context_digest after compaction.`;
    }
  }
  return null;
}

// Business purpose: evaluates a parsed `PreToolUse` hook payload from Claude CLI or Codex CLI and decides whether to allow or deny the tool call.
// Technical description: allows `mcp__forge__*` tools, denies built-in file read/search/edit tools in `TOOL_GUIDANCE_MAP`, inspects shell commands for file read/write violations, and falls back to a deny decision when invoked without tool metadata.
export function evaluatePreToolHookPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return buildPreToolHookResponse("deny", DEFAULT_DENY_REASON);
  }
  const toolName = String(payload.tool_name ?? payload.toolName ?? payload.tool ?? payload.name ?? "").trim();
  if (!toolName) {
    return buildPreToolHookResponse("deny", DEFAULT_DENY_REASON);
  }
  if (toolName.startsWith("mcp__forge__")) {
    return buildPreToolHookResponse("allow");
  }
  if (Object.hasOwn(TOOL_GUIDANCE_MAP, toolName)) {
    return buildPreToolHookResponse("deny", `${TOOL_GUIDANCE_MAP[toolName]} Call context_digest after compaction.`);
  }
  if (SHELL_TOOL_NAMES.has(toolName)) {
    const command = extractShellCommand(payload);
    const violationReason = evaluateShellCommand(command);
    if (violationReason) {
      return buildPreToolHookResponse("deny", violationReason);
    }
    return buildPreToolHookResponse("allow");
  }
  return buildPreToolHookResponse("deny", DEFAULT_DENY_REASON);
}

// Business purpose: reads optional JSON hook input from a readable stream without blocking indefinitely when no stdin pipe is attached.
// Technical description: returns immediately for TTY or closed streams and collects UTF-8 chunks with a short idle timeout for non-TTY streams.
export async function readHookStdinPayload(stdin) {
  if (!stdin || stdin.isTTY || stdin.readableEnded || stdin.destroyed) return null;
  if (typeof stdin.text === "function") {
    const raw = (await stdin.text()).trim();
    return raw ? JSON.parse(raw) : null;
  }
  if (typeof stdin[Symbol.asyncIterator] !== "function" && typeof stdin.on !== "function") return null;

  return new Promise((resolve) => {
    let raw = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener?.("data", onData);
      stdin.removeListener?.("end", onEnd);
      stdin.removeListener?.("error", onEnd);
      const trimmed = raw.trim();
      if (!trimmed) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(trimmed));
      } catch {
        resolve(null);
      }
    };
    const onData = (chunk) => { raw += String(chunk); };
    const onEnd = () => finish();
    const timer = setTimeout(finish, 30);
    if (typeof timer.unref === "function") timer.unref();
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onEnd);
    if (typeof stdin.resume === "function") stdin.resume();
  });
}
