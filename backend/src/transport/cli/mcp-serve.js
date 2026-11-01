// Business purpose: runs the project-scoped Forge MCP server over stdio (`forge mcp-serve`) so external Claude CLI and Codex CLI sessions can invoke `mcp__forge__*` discovery, git, and compact context tools directly against the project's `.nf/` SQLite index and CodeCacheService without polluting JSON-RPC stdout framing.
// Technical description: ensures the `.nf/` runtime layout and SQLite index database, wires `DatabaseService`, `FileService`, `createCodeSearch`, `createCodeCacheService`, `createOwnerConversationTools`, and `createCodexForgeMcpSession`, registers `context_digest`, records tool calls into the Session Compact Ledger, and bridges stdio JSON-RPC messages while routing all operational logs to stderr or `.nf/` log files.

import { createHash } from "node:crypto";
import { acquireMcpRuntimeLock } from "./mcp-runtime-lock.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import readline from "node:readline";
import { loadConfig } from "../../bootstrap/config.js";
import { createFileService } from "../../infrastructure/filesystem/file-service.js";
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { resolveRuntimePath } from "../../infrastructure/filesystem/runtime-layout.js";
import { createGitService } from "../../infrastructure/git/git-service.js";
import { createDatabaseService } from "../../infrastructure/sqlite/database-service.js";
import { ensureRuntimeDir } from "../../infrastructure/sqlite/index-database.js";
import { createCodexForgeMcpSession } from "../../modules/agent/codex-forge-mcp-session.js";
import { createCodeCacheService } from "../../modules/context/code-cache-service.js";
import { createCodeSearch } from "../../modules/index/code-search.js";
import { rebuildIndex } from "../../modules/index/index-rebuild.js";
import { createOwnerConversationTools } from "../../tools/roles/owner-conversation-tools.js";
import { ownerRoleTools } from "../../tools/roles/owner-role-tool-policy.js";
import {
  contextDigestDefinition,
  reconcileLedgerWithDisk,
  recordMcpLedgerToolCall
} from "./mcp-compact-ledger.js";

// Business purpose: creates an in-process Forge MCP runtime bound to a project's `.nf/` SQLite index, CodeCacheService, FileService, and Session Compact Ledger so both stdio transport and automated integration tests can execute JSON-RPC MCP requests (`initialize`, `tools/list`, `tools/call`).
// Technical description: opens the index database via `createDatabaseService`, builds baseline index rows when the database is empty, constructs `createOwnerConversationTools` with `context_digest`, wraps tool execution with `recordMcpLedgerToolCall`, and delegates JSON-RPC framing to `createCodexForgeMcpSession`.
export async function createProjectMcpRuntime({
  projectRoot = process.cwd(),
  role = "system_engineer",
  autoIndex = true,
  stderr = process.stderr
} = {}) {
  const root = resolve(projectRoot);
  const projectId = `PRJ-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
  const config = loadConfig({ cwd: root });
  await ensureRuntimeDir(root);
  const logFilePath = resolveMcpLogPath(root);
  const diagnosticLogger = (entry) => writeDiagnosticLog(logFilePath, stderr, entry);

  const databaseService = await createDatabaseService({
    dataDir: root,
    runtimeDir: statePath("wc")
  });

  if (autoIndex) {
    try {
      const rows = databaseService.read("SELECT COUNT(*) AS count FROM files");
      if (Number(rows?.[0]?.count ?? 0) === 0) {
        await rebuildIndex({
          projectRoot: root,
          database: databaseService,
          ignore: config.watcherIgnore
        });
      }
    } catch (error) {
      diagnosticLogger({ event: "mcp_serve.auto_index_warning", message: error.message });
    }
  }

  const fileService = createFileService({
    projectRoot: root,
    watcherIgnore: config.watcherIgnore,
    logger: { warn: (msg, meta) => diagnosticLogger({ event: "file_service.warn", message: msg, ...meta }) }
  });
  const codeSearch = createCodeSearch({ database: databaseService });
  const codeCache = createCodeCacheService({
    projectId,
    fileService,
    codeSearch,
    logger: (event) => diagnosticLogger(event)
  });
  const gitService = createGitService({ projectRoot: root });
  const allowedTools = ownerRoleTools(role);
  const toolContext = {
    project_id: projectId,
    project_root: root,
    task_id: `MCP-${projectId}`,
    correlation_id: `CORR-MCP-${projectId}`,
    agent_identity: {
      agent_id: `mcp-cli-${role}`,
      agent_name: "Forge MCP CLI",
      role,
      provider: "mcp-stdio"
    },
    capabilities: allowedTools,
    execution_file_access: {
      role,
      project_root: root,
      allowed_paths: ["*"],
      allowed_prefixes: [""]
    },
    source_metadata_receipts: new Map(),
    changed_paths: []
  };

  const ownerTools = createOwnerConversationTools({
    role,
    projectRoot: root,
    fileService,
    codeCache,
    codeSearch,
    gitService,
    projectLogger: (event) => diagnosticLogger(event),
    context: toolContext
  });

  const definitions = [...ownerTools.definitions, contextDigestDefinition];
  const registry = {};
  for (const [name, handler] of Object.entries(ownerTools.registry)) {
    registry[name] = {
      // Business purpose: executes a Forge tool within the MCP session and immediately records its SHA-256 checksum receipt into the project's Session Compact Ledger.
      // Technical description: invokes the underlying owner tool handler, invalidates CodeCacheService on mutations, and calls recordMcpLedgerToolCall.
      async execute(input = {}, ctx = toolContext) {
        const result = await handler.execute(input, ctx);
        try {
          recordMcpLedgerToolCall(root, { toolName: name, input, result });
        } catch (ledgerError) {
          diagnosticLogger({ event: "mcp_serve.ledger_write_failed", tool: name, message: ledgerError.message });
        }
        return result;
      }
    };
  }

  registry.context_digest = {
    // Business purpose: serves the `mcp__forge__context_digest` MCP tool so Claude CLI and Codex CLI can inspect verified SHA-256 receipts and disk freshness after context compaction.
    // Technical description: calls reconcileLedgerWithDisk for the current project root and returns the structured digest payload.
    async execute(input = {}) {
      const refreshDiskStatus = input?.refresh_disk_status !== false;
      return reconcileLedgerWithDisk(root, undefined, { refreshDiskStatus });
    }
  };

  const session = await createCodexForgeMcpSession({
    registry,
    context: toolContext,
    definitions
  });

  const releaseRuntimeLock = acquireMcpRuntimeLock(root);

  // Business purpose: dispatches a single JSON-RPC 2.0 request to the underlying Codex Forge MCP session and returns its JSON-RPC response object.
  // Technical description: sends an authenticated HTTP POST to the local session endpoint and parses the resulting JSON-RPC envelope.
  async function handleJsonRpc(message) {
    if (!message || typeof message !== "object") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    if (message.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: {
          protocolVersion: message.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "nodeforge", version: "1.0.0" }
        }
      };
    }
    if (message.id === undefined) {
      return null;
    }
    const response = await fetch(session.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(message)
    });
    return response.json();
  }

  // Business purpose: cleanly releases the MCP HTTP session, in-memory code cache, and SQLite index database connection when the CLI server exits.
  // Technical description: closes `session`, `codeCache`, and `databaseService` in sequence.
  async function close() {
    try { await session.close(); }
    finally { codeCache.close(); try { await databaseService.close(); } finally { releaseRuntimeLock(); } }
  }

  return Object.freeze({
    projectRoot: root,
    projectId,
    tools: session.tools,
    session,
    handleJsonRpc,
    close
  });
}

// Business purpose: parses CLI arguments and runs the stdio JSON-RPC loop for `forge mcp-serve [--project <path>]`.
// Technical description: reads line-delimited JSON-RPC messages from `stdin`, writes only valid JSON-RPC responses to `stdout`, and routes errors/diagnostics to `stderr` or `.nf/` logs.
export async function runMcpServeCli(args = [], {
  cwd = process.cwd(),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  let projectRoot = cwd;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--project") {
      if (i + 1 >= args.length || !String(args[i + 1]).trim()) {
        stderr.write("Missing value for --project.\n");
        return 1;
      }
      projectRoot = resolve(cwd, String(args[i + 1]).trim());
      i += 1;
    } else if (String(args[i]).startsWith("--")) {
      stderr.write(`Unknown option for mcp-serve: ${args[i]}\n`);
      return 1;
    }
  }

  let runtime;
  try {
    runtime = await createProjectMcpRuntime({ projectRoot, stderr });
  } catch (error) {
    stderr.write(`Failed to initialize Forge MCP server: ${error.message}\n`);
    return 1;
  }

  const writeRpc = (payload) => {
    if (payload) stdout.write(`${JSON.stringify(payload)}\n`);
  };

  return new Promise((resolveExit) => {
    const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
    const pending = new Set();
    let closed = false;

    const shutdown = async (code = 0) => {
      if (closed) return;
      closed = true;
      rl.close();
      await Promise.allSettled([...pending]);
      await runtime.close();
      resolveExit(code);
    };

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch (error) {
        writeRpc({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Invalid JSON: ${error.message}` } });
        return;
      }
      const task = runtime.handleJsonRpc(message)
        .then((response) => writeRpc(response))
        .catch((error) => {
          if (message?.id !== undefined) {
            writeRpc({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error.message } });
          }
        })
        .finally(() => pending.delete(task));
      pending.add(task);
    });

    rl.on("close", () => {
      void shutdown(0);
    });
  });
}

// Business purpose: determines the `.nf/` diagnostic log file location for `forge mcp-serve` so operational logs never contaminate the stdio JSON-RPC stream.
// Technical description: resolves `statePath("nf/logs/mcp-serve.log")` inside the project runtime directory.
function resolveMcpLogPath(projectRoot) {
  try {
    return resolveRuntimePath(projectRoot, statePath("nf/logs/mcp-serve.log"));
  } catch (error) {
    console.error(`Cannot resolve MCP log layout: ${error.message}`);
    return resolve(projectRoot, statePath("nf/logs/mcp-serve.log"));
  }
}

// Business purpose: appends structured diagnostic events to the `.nf/` MCP log file without ever writing to `stdout`.
// Technical description: ensures the parent log directory exists and appends a single-line JSON log record, ignoring best-effort I/O errors.
function writeDiagnosticLog(logFilePath, _stderr, entry) {
  // eslint-disable-next-line no-silent-catch -- Diagnostics must never interrupt the MCP stdio JSON-RPC transport.
  try {
    mkdirSync(dirname(logFilePath), { recursive: true });
    appendFileSync(logFilePath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, "utf8");
  } catch (error) {
    _stderr.write(`Forge MCP diagnostic logging failed: ${error.message}\n`);
  }
}
