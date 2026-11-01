// Business purpose: protects developer-owned MCP configuration before installation changes any file.
// Technical description: validates JSON container shapes and rejects unmanaged Forge server collisions
// across Claude and Codex project configuration, preventing partial installs on known conflicts.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CODEX_BEGIN_MARKER, CODEX_END_MARKER } from "./mcp-config-merge.js";

// Business purpose: preserves existing developer servers and permissions during Forge registration.
// Technical description: parses both JSON configurations before writes and checks ownership of the
// reserved Forge entries, including marker integrity in the section-based Codex configuration.
export function assertMcpConfigInstallSafe(projectRoot) {
  for (const name of [".mcp.json", ".claude/settings.local.json", ".codex/hooks.json"]) {
    const path = resolve(projectRoot, name);
    if (!existsSync(path)) continue;
    let config;
    try {
      config = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`Invalid JSON syntax in ${path}: ${error.message}`);
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`Invalid configuration object: ${path}`);
    for (const key of ["mcpServers", "hooks"]) {
      if (config[key] !== undefined && (!config[key] || typeof config[key] !== "object" || Array.isArray(config[key]))) {
        throw new Error(`Invalid ${key} configuration: ${path}`);
      }
    }
    if (name === ".mcp.json" && config.mcpServers?.forge !== undefined && config.mcpServers.forge?._managed_by !== "nodeforge") {
      throw new Error(`Forge MCP server is user-managed; preserve or rename it before installing: ${path}`);
    }
    if (config.enabledMcpjsonServers !== undefined && !Array.isArray(config.enabledMcpjsonServers)) throw new Error(`Invalid enabled MCP servers: ${path}`);
    for (const event of ["PreToolUse", "PreCompact", "SessionStart"]) {
      if (config.hooks?.[event] !== undefined && !Array.isArray(config.hooks[event])) throw new Error(`Invalid ${event} hooks: ${path}`);
    }
  }
  const path = resolve(projectRoot, ".codex/config.toml");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  const begin = raw.indexOf(CODEX_BEGIN_MARKER);
  const end = raw.indexOf(CODEX_END_MARKER);
  if ((begin >= 0 || end >= 0) && (begin < 0 || end < begin)) throw new Error(`Incomplete NodeForge markers: ${path}`);
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      if (!/^(?:\[[A-Za-z0-9_."'-]+(?:\s*\.\s*[A-Za-z0-9_."'-]+)*\]|\[\[[A-Za-z0-9_."'-]+(?:\s*\.\s*[A-Za-z0-9_."'-]+)*\]\])\s*(?:#.*)?$/.test(trimmed)) {
        throw new Error(`Malformed TOML section header in ${path}: ${trimmed}`);
      }
    } else if ((trimmed.match(/(?<!\\)"/g) ?? []).length % 2 !== 0) {
      throw new Error(`Malformed TOML unclosed quote in ${path}: ${trimmed}`);
    }
  }
  const sections = raw.match(/^\s*\[(?:"mcp_servers"|'mcp_servers'|mcp_servers)\s*\.\s*(?:"forge"|'forge'|forge)\s*\][^\n]*(?:\n(?!\s*\[)[^\n]*)*/gm) ?? [];
  if (sections.some((section) => !/^\s*#\s*_managed_by\s*=\s*"nodeforge"\s*$/m.test(section))) {
    throw new Error(`Forge MCP server is user-managed; preserve or rename it before installing: ${path}`);
  }
}
