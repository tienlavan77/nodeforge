<!-- Business purpose: helps developers connect external Claude and Codex terminals to Forge discovery and recover verified file receipts after compaction. Technical description: documents project-local CLI installation, stdio transport, lifecycle commands, hooks, runtime storage, and verification limits. -->
# Forge MCP CLI

From the NodeForge checkout, use the CLI directly:

```sh
node backend/src/transport/cli/index.js mcp install --project /path/to/project
node backend/src/transport/cli/index.js mcp status --project /path/to/project
```

The backend package also declares the `forge` binary for package installation/linking.
Installation registers `forge` in the target project's `.mcp.json` and
`.codex/config.toml`, plus lifecycle hooks in `.claude/settings.local.json` for
Claude CLI and in `.codex/config.toml` (`[[hooks.PreToolUse]]`,
`[[hooks.SessionStart]]`) and `.codex/hooks.json` for Codex CLI.
Existing third-party servers, hooks and permissions are retained. An unmanaged
server already named `forge` must be preserved or renamed before installing.

Run `forge mcp-serve --project /path/to/project` for newline-delimited MCP
JSON-RPC over stdio. Only protocol responses go to stdout; diagnostics go to
runtime logs or stderr. The runtime initializes the project index and exposes
Forge metadata, symbol reads, search, tree/file listing, Git reads and schema lookup.

Use `mcp__forge__context_digest` after compaction to retrieve verified checksums
and inspected symbols. The CLI equivalent is:

```sh
forge mcp context-digest --project /path/to/project
```

For both Claude CLI and Codex CLI, the installed `SessionStart` hook (`forge mcp context-digest --project <root>`)
injects the SHA-256 receipt digest after compact/resume, and Claude's `PreCompact`
hook also emits the digest. The `PreToolUse` hook (`forge mcp pre-tool-hook --project <root>`)
inspects stdin payloads across Claude CLI and Codex CLI, denying built-in file
discovery/mutation tools (`Read`, `Grep`, `Glob`, `Edit`, `Write`, `MultiEdit`,
`NotebookEdit`, `apply_patch`, `read_file`, `list_dir`, `write_file`, `edit_file`)
and direct shell file reads/mutations while allowing safe test/build commands and
directing the agent to the corresponding `mcp__forge__*` tool. `forge mcp status`
verifies that both the MCP server entry and lifecycle hooks are installed for
Claude CLI and Codex CLI (`configured: true`).

Runtime paths follow the project's existing runtime layout, including legacy
`.nf/` and grouped `.forge/runtime/` layouts. The compact ledger stores
receipts without raw source or search patterns. A digest marks modified,
deleted or unreadable paths so the agent can refresh just those receipts.

```sh
forge mcp uninstall --project /path/to/project
forge mcp uninstall --project /path/to/project --purge
```

Uninstall removes managed configuration and retains the index by default
(`--keep-index`). `--purge` removes runtime storage after checking process
locks. Do not use it to retain other project runtime state.

Automated tests cover isolated project lifecycle, stdio requests, discovery,
receipt freshness and hooks. They do not establish a live Claude/Codex
`/compact` session result.
