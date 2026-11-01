// Business purpose: performs surgical, non-destructive configuration merge, unmerge, and status inspection on `.mcp.json`, `.claude/settings.local.json`, and `.codex/config.toml` so `forge mcp install`, `forge mcp uninstall`, and `forge mcp status` never overwrite or lose third-party MCP servers, permissions, or user hooks.
// Technical description: parses JSON and section-scoped TOML configurations, tags NodeForge-managed entries with `_managed_by: "nodeforge"` (or `# _managed_by = "nodeforge"` in TOML), and removes empty configuration files during uninstall only when those files were originally created by NodeForge.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NODEFORGE_MANAGED_TAG = "nodeforge";
export const CODEX_BEGIN_MARKER = "# >>> nodeforge-mcp-begin (_managed_by: \"nodeforge\") >>>";
export const CODEX_END_MARKER = "# <<< nodeforge-mcp-end <<<";

const DEFAULT_CLI_SCRIPT = fileURLToPath(new URL("./index.js", import.meta.url));

// Business purpose: builds the command and arguments used by external Claude CLI and Codex CLI configurations to invoke the NodeForge CLI for `mcp-serve` and compaction hooks.
// Technical description: returns the current Node executable path and the resolved CLI entrypoint script path along with `--project <root>`.
// Business purpose: keeps installed hooks safe for project paths containing shell metacharacters.
// Technical description: quotes each POSIX shell argument literally, escaping embedded apostrophes.
function quoteHookArgument(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}

export function resolveForgeCliCommand(projectRoot, { cliScriptPath = DEFAULT_CLI_SCRIPT, nodeExecPath = process.execPath } = {}) {
  const root = resolve(projectRoot);
  return {
    command: nodeExecPath,
    mcpServeArgs: [cliScriptPath, "mcp-serve", "--project", root],
    digestHookCommand: `${quoteHookArgument(nodeExecPath)} ${quoteHookArgument(cliScriptPath)} mcp context-digest --project ${quoteHookArgument(root)}`,
    preToolHookCommand: `${quoteHookArgument(nodeExecPath)} ${quoteHookArgument(cliScriptPath)} mcp pre-tool-hook --project ${quoteHookArgument(root)}`
  };
}

// Business purpose: installs or updates the `forge` MCP server entry inside `.mcp.json` for Claude CLI while preserving any other MCP servers configured by the developer.
// Technical description: parses `.mcp.json` if present, sets `mcpServers.forge` with `_managed_by: "nodeforge"`, and records `_nodeforge_created_file: true` only when creating a brand-new file.
export const CLAUDE_PRE_TOOL_MATCHER = "Read|Grep|Glob|Edit|Write|MultiEdit|NotebookEdit|Bash";
export const CODEX_PRE_TOOL_MATCHER = "Read|Grep|Glob|Edit|Write|MultiEdit|NotebookEdit|apply_patch|read_file|list_dir|write_file|edit_file|Bash|shell|exec_command";

// Business purpose: constructs a standardized NodeForge-managed hook group entry for Claude and Codex hook configurations.
// Technical description: returns an object with `matcher`, `_managed_by: "nodeforge"`, and a single command hook entry.
function buildManagedHookSpec(matcher, command) {
  return { matcher, _managed_by: NODEFORGE_MANAGED_TAG, hooks: [{ type: "command", command, _managed_by: NODEFORGE_MANAGED_TAG }] };
}

// Business purpose: installs or updates the `forge` MCP server entry inside `.mcp.json` for Claude CLI while preserving any other MCP servers configured by the developer.
// Technical description: parses `.mcp.json` if present, sets `mcpServers.forge` with `_managed_by: "nodeforge"`, and records `_nodeforge_created_file: true` only when creating a brand-new file.
export function mergeClaudeMcpJson(projectRoot, options = {}) {
  const filePath = resolve(projectRoot, ".mcp.json");
  const existed = existsSync(filePath);
  const current = existed ? readJsonSafe(filePath) : {};
  const cli = resolveForgeCliCommand(projectRoot, options);
  const mcpServers = current.mcpServers && typeof current.mcpServers === "object" ? { ...current.mcpServers } : {};
  mcpServers.forge = { type: "stdio", command: cli.command, args: cli.mcpServeArgs, _managed_by: NODEFORGE_MANAGED_TAG };
  writeJsonFile(filePath, { ...current, ...(!existed ? { _nodeforge_created_file: true } : {}), mcpServers });
  return { path: filePath, created: !existed, updated: true };
}

// Business purpose: removes only the NodeForge-managed `forge` server entry from `.mcp.json` and deletes `.mcp.json` if NodeForge created it and no user entries remain.
// Technical description: checks `mcpServers.forge._managed_by === "nodeforge"`, deletes that key, and unlinks the file when empty and created by NodeForge.
export function unmergeClaudeMcpJson(projectRoot) {
  const filePath = resolve(projectRoot, ".mcp.json");
  if (!existsSync(filePath)) return { path: filePath, removed: false, fileDeleted: false };
  const current = readJsonSafe(filePath);
  const mcpServers = current.mcpServers && typeof current.mcpServers === "object" ? { ...current.mcpServers } : {};
  const forgeEntry = mcpServers.forge;
  if (!forgeEntry || typeof forgeEntry !== "object" || (forgeEntry._managed_by !== NODEFORGE_MANAGED_TAG && current._nodeforge_created_file !== true)) {
    return { path: filePath, removed: false, fileDeleted: false };
  }
  delete mcpServers.forge;
  const next = { ...current };
  if (Object.keys(mcpServers).length > 0) next.mcpServers = mcpServers; else delete next.mcpServers;
  return finalizeUnmergedJson(filePath, next, true);
}

// Business purpose: finalizes a JSON config file after unmerging NodeForge entries, deleting the file if NodeForge created it and no user settings remain.
// Technical description: strips `_nodeforge_created_file`, unlinks empty NodeForge-created files, or writes the remaining JSON object back to disk.
function finalizeUnmergedJson(filePath, next, removed) {
  const createdByNodeforge = next._nodeforge_created_file === true;
  delete next._nodeforge_created_file;
  if (Object.keys(next).length === 0 && createdByNodeforge) {
    rmSync(filePath, { force: true });
    return { path: filePath, removed, fileDeleted: true };
  }
  if (createdByNodeforge) next._nodeforge_created_file = true;
  writeJsonFile(filePath, next);
  return { path: filePath, removed, fileDeleted: false };
}

// Business purpose: registers NodeForge tool-routing (`PreToolUse`) and context-compaction (`PreCompact`, `SessionStart`) hooks in `.claude/settings.local.json` without disturbing existing user permissions or third-party hooks.
// Technical description: merges `_managed_by: "nodeforge"` hook entries into `hooks.PreToolUse`, `hooks.PreCompact`, and `hooks.SessionStart` arrays while deduplicating prior NodeForge entries.
export function mergeClaudeSettingsLocal(projectRoot, options = {}) {
  const filePath = resolve(projectRoot, ".claude", "settings.local.json");
  const existed = existsSync(filePath);
  const current = existed ? readJsonSafe(filePath) : {};
  const cli = resolveForgeCliCommand(projectRoot, options);
  const hooks = current.hooks && typeof current.hooks === "object" ? { ...current.hooks } : {};
  hooks.PreToolUse = upsertManagedHookGroup(hooks.PreToolUse, buildManagedHookSpec(CLAUDE_PRE_TOOL_MATCHER, cli.preToolHookCommand));
  hooks.PreCompact = upsertManagedHookGroup(hooks.PreCompact, buildManagedHookSpec(".*", cli.digestHookCommand));
  hooks.SessionStart = upsertManagedHookGroup(hooks.SessionStart, buildManagedHookSpec("compact|resume|.*", cli.digestHookCommand));
  const next = { ...current, ...(!existed ? { _nodeforge_created_file: true } : {}), hooks };
  next.enabledMcpjsonServers = [...new Set([...(current.enabledMcpjsonServers ?? []), "forge"])];
  writeJsonFile(filePath, next);
  return { path: filePath, created: !existed, updated: true };
}

// Business purpose: strips NodeForge-managed hook groups from a Claude or Codex JSON hooks file while preserving user-owned hooks and settings.
// Technical description: filters out `_managed_by === "nodeforge"` hook groups across the specified event keys and delegates cleanup to `finalizeUnmergedJson`.
function unmergeManagedHooksJsonFile(filePath, eventNames, { stripForgeServer = false } = {}) {
  if (!existsSync(filePath)) return { path: filePath, removed: false, fileDeleted: false };
  const current = readJsonSafe(filePath);
  const hooks = current.hooks && typeof current.hooks === "object" && !Array.isArray(current.hooks) ? { ...current.hooks } : {};
  let removedAny = false;
  for (const eventName of eventNames) {
    if (!Array.isArray(hooks[eventName])) continue;
    const filtered = hooks[eventName].filter((group) => !isManagedHookGroup(group));
    if (filtered.length !== hooks[eventName].length) removedAny = true;
    if (filtered.length > 0) hooks[eventName] = filtered; else delete hooks[eventName];
  }
  const next = { ...current };
  if (Object.keys(hooks).length > 0) next.hooks = hooks; else delete next.hooks;
  if (stripForgeServer && removedAny && Array.isArray(next.enabledMcpjsonServers)) {
    next.enabledMcpjsonServers = next.enabledMcpjsonServers.filter((name) => name !== "forge");
    if (next.enabledMcpjsonServers.length === 0) delete next.enabledMcpjsonServers;
  }
  return finalizeUnmergedJson(filePath, next, removedAny);
}

// Business purpose: strips only NodeForge-managed hooks from `.claude/settings.local.json` and removes the file if it was created by NodeForge and becomes empty.
// Technical description: filters out hook groups tagged with `_managed_by: "nodeforge"` across `PreToolUse`, `PreCompact`, and `SessionStart`, preserving all user-defined hooks and permissions.
export function unmergeClaudeSettingsLocal(projectRoot) {
  return unmergeManagedHooksJsonFile(resolve(projectRoot, ".claude", "settings.local.json"), ["PreToolUse", "PreCompact", "SessionStart"], { stripForgeServer: true });
}

// Business purpose: installs or updates NodeForge `PreToolUse` and `SessionStart` hooks in `.codex/hooks.json` without disturbing existing user hooks.
// Technical description: merges `_managed_by: "nodeforge"` hook groups into `hooks.PreToolUse` and `hooks.SessionStart` inside `.codex/hooks.json`.
export function mergeCodexHooksJson(projectRoot, options = {}) {
  const filePath = resolve(projectRoot, ".codex", "hooks.json");
  const existed = existsSync(filePath);
  const current = existed ? readJsonSafe(filePath) : {};
  const cli = resolveForgeCliCommand(projectRoot, options);
  const hooks = current.hooks && typeof current.hooks === "object" && !Array.isArray(current.hooks) ? { ...current.hooks } : {};
  hooks.PreToolUse = upsertManagedHookGroup(hooks.PreToolUse, buildManagedHookSpec(CODEX_PRE_TOOL_MATCHER, cli.preToolHookCommand));
  hooks.SessionStart = upsertManagedHookGroup(hooks.SessionStart, buildManagedHookSpec("compact|resume|.*", cli.digestHookCommand));
  writeJsonFile(filePath, { ...current, ...(!existed ? { _nodeforge_created_file: true } : {}), hooks });
  return { path: filePath, created: !existed, updated: true };
}

// Business purpose: removes only NodeForge-managed hooks from `.codex/hooks.json` and deletes the file if NodeForge created it and no user hooks remain.
// Technical description: delegates removal of `PreToolUse` and `SessionStart` managed hook groups from `.codex/hooks.json` to `unmergeManagedHooksJsonFile`.
export function unmergeCodexHooksJson(projectRoot) {
  return unmergeManagedHooksJsonFile(resolve(projectRoot, ".codex", "hooks.json"), ["PreToolUse", "SessionStart"]);
}

// Business purpose: merges the `[mcp_servers.forge]` block and Codex lifecycle hooks into `.codex/config.toml` and `.codex/hooks.json` without altering other user settings.
// Technical description: replaces an existing NodeForge marker block or managed sections in `.codex/config.toml` and synchronizes `.codex/hooks.json`.
export function mergeCodexConfigToml(projectRoot, options = {}) {
  const filePath = resolve(projectRoot, ".codex", "config.toml");
  const existed = existsSync(filePath);
  const raw = existed ? readFileSync(filePath, "utf8") : "";
  const cli = resolveForgeCliCommand(projectRoot, options);
  const createdHeader = !existed ? "# _nodeforge_created_file = true\n" : "";
  const block = [
    CODEX_BEGIN_MARKER,
    "[mcp_servers.forge]", "# _managed_by = \"nodeforge\"",
    `command = ${JSON.stringify(cli.command)}`, `args = ${JSON.stringify(cli.mcpServeArgs)}`,
    "enabled = true", "startup_timeout_sec = 10", "tool_timeout_sec = 120", "",
    "[[hooks.PreToolUse]]", "# _managed_by = \"nodeforge\"",
    `matcher = ${JSON.stringify(CODEX_PRE_TOOL_MATCHER)}`,
    `hooks = [{ type = "command", command = ${JSON.stringify(cli.preToolHookCommand)}, _managed_by = "nodeforge" }]`, "",
    "[[hooks.SessionStart]]", "# _managed_by = \"nodeforge\"", "matcher = \"compact|resume|.*\"",
    `hooks = [{ type = "command", command = ${JSON.stringify(cli.digestHookCommand)}, _managed_by = "nodeforge" }]`,
    CODEX_END_MARKER
  ].join("\n");
  const prefix = stripManagedCodexBlock(raw).trimEnd();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, prefix ? `${prefix}\n\n${block}\n` : `${createdHeader}${block}\n`, "utf8");
  return { path: filePath, created: !existed, updated: true, hooks_json: mergeCodexHooksJson(projectRoot, options) };
}

// Business purpose: removes only the NodeForge-managed `[mcp_servers.forge]` and hook entries from `.codex/config.toml` and `.codex/hooks.json`, deleting files created by NodeForge when empty.
// Technical description: strips the marker-bounded block and managed sections from `.codex/config.toml` and unmerges `.codex/hooks.json`.
export function unmergeCodexConfigToml(projectRoot) {
  const filePath = resolve(projectRoot, ".codex", "config.toml");
  const hooksUnmerged = unmergeCodexHooksJson(projectRoot);
  if (!existsSync(filePath)) return { path: filePath, removed: hooksUnmerged.removed, fileDeleted: false, hooks_json: hooksUnmerged };
  const raw = readFileSync(filePath, "utf8");
  const stripped = stripManagedCodexBlock(raw);
  const removed = stripped !== raw || hooksUnmerged.removed;
  const createdByNodeforge = /^#\s*_nodeforge_created_file\s*=\s*true\s*$/m.test(stripped);
  const withoutCreatedTag = stripped.replace(/^#\s*_nodeforge_created_file\s*=\s*true\s*\n?/m, "").trim();
  if (!withoutCreatedTag && createdByNodeforge) {
    rmSync(filePath, { force: true });
    return { path: filePath, removed, fileDeleted: true, hooks_json: hooksUnmerged };
  }
  writeFileSync(filePath, stripped.trimEnd() ? `${stripped.trimEnd()}\n` : "", "utf8");
  return { path: filePath, removed, fileDeleted: false, hooks_json: hooksUnmerged };
}

// Business purpose: checks whether a TOML configuration string contains a NodeForge-managed section matching the given header and optional command substring.
// Technical description: scans TOML sections matching `headerPattern` and verifies `_managed_by = "nodeforge"` and `subcommand` presence within the section body.
function hasManagedCodexSection(raw, headerPattern, subcommand) {
  if (!raw) return false;
  const regex = new RegExp(`(?:^|\\n)${headerPattern}\\n([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|\\s*$)`, "g");
  for (const match of raw.matchAll(regex)) {
    if (match[1].includes(NODEFORGE_MANAGED_TAG) && (!subcommand || match[1].includes(subcommand))) return true;
  }
  return false;
}

// Business purpose: inspects whether Claude CLI and Codex CLI have NodeForge MCP configurations and lifecycle hooks installed in the project directory.
// Technical description: checks `.mcp.json`, `.claude/settings.local.json`, `.codex/config.toml`, and `.codex/hooks.json` for `_managed_by: "nodeforge"` entries and hook registrations.
export function inspectCliConfigStatus(projectRoot) {
  const mcpJsonPath = resolve(projectRoot, ".mcp.json");
  const claudeSettingsPath = resolve(projectRoot, ".claude", "settings.local.json");
  const codexTomlPath = resolve(projectRoot, ".codex", "config.toml");
  const codexHooksPath = resolve(projectRoot, ".codex", "hooks.json");

  const mcpJson = existsSync(mcpJsonPath) ? readJsonSafe(mcpJsonPath) : null;
  const claudeMcpInstalled = Boolean(mcpJson?.mcpServers?.forge && mcpJson.mcpServers.forge._managed_by === NODEFORGE_MANAGED_TAG);
  const claudeSettings = existsSync(claudeSettingsPath) ? readJsonSafe(claudeSettingsPath) : null;
  const preToolInstalled = Array.isArray(claudeSettings?.hooks?.PreToolUse) && claudeSettings.hooks.PreToolUse.some(isManagedHookGroup);
  const preCompactInstalled = Array.isArray(claudeSettings?.hooks?.PreCompact) && claudeSettings.hooks.PreCompact.some(isManagedHookGroup);
  const sessionStartInstalled = Array.isArray(claudeSettings?.hooks?.SessionStart) && claudeSettings.hooks.SessionStart.some(isManagedHookGroup);
  const claudeHooksInstalled = preToolInstalled && preCompactInstalled && sessionStartInstalled;
  const claudeConfigured = claudeMcpInstalled && claudeHooksInstalled;

  const codexRaw = existsSync(codexTomlPath) ? readFileSync(codexTomlPath, "utf8") : "";
  const codexServerInstalled = hasManagedCodexSection(codexRaw, "\\[mcp_servers\\.forge\\]");
  const codexHooksJson = existsSync(codexHooksPath) ? readJsonSafe(codexHooksPath) : null;
  const codexJsonPreTool = Array.isArray(codexHooksJson?.hooks?.PreToolUse) && codexHooksJson.hooks.PreToolUse.some(isManagedHookGroup);
  const codexJsonSessionStart = Array.isArray(codexHooksJson?.hooks?.SessionStart) && codexHooksJson.hooks.SessionStart.some(isManagedHookGroup);
  const codexTomlPreTool = hasManagedCodexSection(codexRaw, "\\[\\[?hooks\\.PreToolUse\\]?\\]", "pre-tool-hook");
  const codexTomlSessionStart = hasManagedCodexSection(codexRaw, "\\[\\[?hooks\\.SessionStart\\]?\\]", "context-digest");
  const codexPreToolInstalled = codexTomlPreTool && (!existsSync(codexHooksPath) || codexJsonPreTool);
  const codexSessionStartInstalled = codexTomlSessionStart && (!existsSync(codexHooksPath) || codexJsonSessionStart);
  const codexHooksInstalled = codexPreToolInstalled && codexSessionStartInstalled;
  const codexConfigured = codexServerInstalled && codexHooksInstalled;

  return {
    claude: {
      installed: claudeConfigured, configured: claudeConfigured, mcp_json_installed: claudeMcpInstalled, hooks_installed: claudeHooksInstalled,
      pre_tool_hook_installed: preToolInstalled, pre_compact_hook_installed: preCompactInstalled, session_start_hook_installed: sessionStartInstalled,
      paths: { mcp_json: mcpJsonPath, settings_local: claudeSettingsPath }
    },
    codex: {
      installed: codexConfigured, configured: codexConfigured, mcp_server_installed: codexServerInstalled, hooks_installed: codexHooksInstalled,
      pre_tool_hook_installed: codexPreToolInstalled, session_start_hook_installed: codexSessionStartInstalled,
      paths: { config_toml: codexTomlPath, hooks_json: codexHooksPath }
    }
  };
}

// Business purpose: inserts or updates a NodeForge-managed hook group inside a Claude or Codex settings hook event array while preserving user-defined hook groups.
// Technical description: filters out existing `_managed_by === "nodeforge"` groups and appends the new managed group.
function upsertManagedHookGroup(existingList, managedGroup) {
  const list = Array.isArray(existingList) ? existingList.filter((item) => !isManagedHookGroup(item)) : [];
  return [...list, managedGroup];
}

// Business purpose: identifies whether a hook group in `.claude/settings.local.json` or `.codex/hooks.json` is owned by NodeForge.
// Technical description: checks `group._managed_by === "nodeforge"` or whether all child hooks carry `_managed_by === "nodeforge"`.
function isManagedHookGroup(group) {
  if (!group || typeof group !== "object") return false;
  if (group._managed_by === NODEFORGE_MANAGED_TAG) return true;
  return Array.isArray(group.hooks) && group.hooks.length > 0 && group.hooks.every((h) => h?._managed_by === NODEFORGE_MANAGED_TAG);
}

// Business purpose: removes the NodeForge-managed `[mcp_servers.forge]` and hook sections from a TOML string without touching any other TOML sections.
// Technical description: strips content between `CODEX_BEGIN_MARKER` and `CODEX_END_MARKER` or standalone sections tagged with `_managed_by = "nodeforge"`.
function stripManagedCodexBlock(raw) {
  if (!raw) return "";
  let next = raw;
  const beginIdx = next.indexOf(CODEX_BEGIN_MARKER);
  const endIdx = next.indexOf(CODEX_END_MARKER);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const afterEnd = endIdx + CODEX_END_MARKER.length;
    next = `${next.slice(0, beginIdx).trimEnd()}\n${next.slice(afterEnd).trimStart()}`;
  }
  for (const header of ["\\[mcp_servers\\.forge\\]", "\\[\\[?hooks\\.PreToolUse\\]?\\]", "\\[\\[?hooks\\.SessionStart\\]?\\]"]) {
    const match = new RegExp(`(?:^|\\n)${header}\\n([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|\\s*$)`).exec(next);
    if (match && match[1].includes(NODEFORGE_MANAGED_TAG)) {
      next = `${next.slice(0, match.index).trimEnd()}\n${next.slice(match.index + match[0].length).trimStart()}`;
    }
  }
  return next;
}

// Business purpose: safely parses a JSON configuration file and throws a descriptive error if the user file contains malformed JSON so NodeForge never overwrites corrupted user files.
// Technical description: reads UTF-8 file text and parses JSON, throwing an Error with the file path on syntax failure.
function readJsonSafe(filePath) {
  const text = readFileSync(filePath, "utf8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(`Cannot parse existing configuration file ${filePath}: ${error.message}`);
  }
}

// Business purpose: writes a formatted JSON configuration file to disk, ensuring its parent directory exists.
// Technical description: creates parent directories recursively and writes 2-space indented JSON with a trailing newline.
function writeJsonFile(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
