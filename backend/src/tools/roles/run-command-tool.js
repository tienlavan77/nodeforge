// Business purpose: Exposes the governed `run_command` tool to System Engineer and Coder roles while automatically synchronizing working-tree file mutations with the Node change ledger and active_file_checksums.
// Technical description: Authorizes the caller (failing closed on missing/unauthorized roles), validates structured command inputs, snapshots the working tree before and after execution (including on timeout or failure), enforces role/ticket path scope for created, modified, and deleted paths, and reconciles sha256 checksums.

import {
  ALLOWED_COMMANDS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  createNodeCommandService
} from "../../infrastructure/command/command-service.js";
import { snapshotWorkingTree, reconcileWorkingTreeMutation } from "../../infrastructure/git/workspace-ledger-sync.js";
import { authorizeTool, isAgentPathAllowed } from "../governance/tool-authorization.js";
import { ConfigurationError } from "../../shared/errors.js";

export const runCommandDefinition = Object.freeze({
  name: "run_command",
  description:
    "Execute a governed project command (node, pnpm, npm, npx, php, zip, unzip) through Node Command & Archive Service with shell: false, automatic secret redaction, and working-tree sha256 ledger reconciliation. Direct or indirect git execution is forbidden; use the Forge Git tools instead.",
  input_schema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["command", "args"],
    properties: Object.freeze({
      command: Object.freeze({
        type: "string",
        enum: ALLOWED_COMMANDS,
        description: "Fixed Node-mediated capability identifier (node, pnpm, npm, npx, php, zip, unzip)."
      }),
      args: Object.freeze({
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: Object.freeze({ type: "string", minLength: 1, maxLength: 1000 }),
        description: "Structured argument list passed with shell: false. No parent traversal (..) or protected .git/.forge mutation."
      }),
      cwd: Object.freeze({
        type: "string",
        minLength: 1,
        maxLength: 500,
        default: ".",
        description: "Optional project-relative working directory inside projectRoot."
      }),
      timeout_ms: Object.freeze({
        type: "integer",
        minimum: 100,
        maximum: MAX_COMMAND_TIMEOUT_MS,
        default: DEFAULT_COMMAND_TIMEOUT_MS,
        description: "Optional timeout in milliseconds (100..180000, default 60000)."
      })
    })
  })
});

// Business purpose: Verifies that a project-relative path is permitted by both the role file access policy and any explicit allowed_file_paths or allowed_prefixes on the execution context.
// Technical description: Evaluates isAgentPathAllowed for the requested operation and, when allowed_file_paths or allowed_prefixes are configured on context, enforces that the normalized path matches an allowed file or directory prefix.
function isScopedMutationAllowed(path, context, operation = "write") {
  if (!isAgentPathAllowed(path, context, { operation })) return false;
  const files = context?.allowed_file_paths ?? context?.allowedFilePaths;
  const prefixes = context?.allowed_prefixes ?? context?.allowedPrefixes;
  if (!Array.isArray(files) && !Array.isArray(prefixes)) return true;
  if (operation === "read" && path === ".") return true;
  const normalized = String(path ?? "").replace(/^\.\//, "").replace(/\/$/, "");
  const inFiles = Array.isArray(files) && files.includes(normalized);
  const inPrefixes = Array.isArray(prefixes) && prefixes.some((prefix) => {
    const clean = String(prefix ?? "").replace(/^\.\//, "").replace(/\/$/, "");
    return normalized === clean || normalized.startsWith(`${clean}/`);
  });
  return inFiles || inPrefixes;
}

// Business purpose: Creates the governed run_command tool bound to the project root, change ledger, and conversation state store.
// Technical description: Wraps NodeCommandService.executeCommand with pre/post working-tree snapshots, error-path reconciliation, and scope enforcement for Coder and System Engineer.
export function createRunCommandTool({
  projectRoot,
  commandService = projectRoot ? createNodeCommandService({ projectRoot }) : null,
  changeLedger,
  conversationStateStore,
  conversationId,
  logger
} = {}) {
  if (!commandService || typeof commandService.executeCommand !== "function") {
    throw new ConfigurationError("run_command tool requires a NodeCommandService instance or valid projectRoot.");
  }

  return Object.freeze({
    name: "run_command",
    definition: runCommandDefinition,
    execute
  });

  // Business purpose: Runs one governed command and synchronizes any resulting file changes or deletions with the active session or ticket ledger.
  // Technical description: Authorizes the caller (failing closed on missing roles), enforces path scope for created, modified, and deleted paths, reconciles even if execution times out or throws, and returns reconciled checksums.
  async function execute(input = {}, context = {}) {
    authorizeTool("run_command", context);
    const role = context?.agent_identity?.role;
    if (!role || !["system_engineer", "coder"].includes(role)) {
      throw Object.assign(new ConfigurationError("run_command is permitted only for System Engineer and Coder."), { code: "TOOL_FORBIDDEN" });
    }
    const validated = commandService.validateInput(input);
    if (validated.cwd !== "." && !isScopedMutationAllowed(validated.cwd, context, "read")) {
      throw Object.assign(new ConfigurationError(`run_command cwd '${validated.cwd}' is outside the authorized scope.`), { code: "TOOL_RESOURCE_FORBIDDEN" });
    }

    const effectiveRoot = projectRoot ?? context?.project_root;
    const beforeSnapshot = await snapshotWorkingTree(effectiveRoot, { includeContent: Boolean(changeLedger) });
    logger?.emit?.({
      event_name: "forge.run_command_started",
      level: "info",
      status: "started",
      message: `run_command ${validated.command} started.`,
      task_id: context?.task_id ?? context?.taskId ?? "RUN-COMMAND",
      correlation_id: context?.correlation_id,
      source: "run-command-tool",
      payload: { command: validated.command, cwd: validated.cwd, arg_count: validated.args.length }
    });

    let commandResult;
    let commandFailure = null;
    try {
      commandResult = await commandService.executeCommand(input, { signal: context?.abortSignal });
    } catch (error) {
      commandFailure = error;
    }

    const afterSnapshot = await snapshotWorkingTree(effectiveRoot, { includeContent: Boolean(changeLedger) });
    const reconciled = await reconcileWorkingTreeMutation({
      projectRoot: effectiveRoot,
      beforeSnapshot,
      afterSnapshot,
      context,
      changeLedger,
      conversationStateStore,
      conversationId: conversationId ?? context?.conversation_id,
      logger,
      toolName: "run_command"
    });

    for (const [path, meta] of afterSnapshot.entries()) {
      const prev = beforeSnapshot.get(path);
      if ((!prev || prev.sha256 !== meta.sha256) && !isScopedMutationAllowed(path, context, "write")) {
        throw Object.assign(new ConfigurationError(`run_command modified path outside authorized scope: ${path}`), { code: "TOOL_RESOURCE_FORBIDDEN" });
      }
    }
    for (const [path] of beforeSnapshot.entries()) {
      if (!afterSnapshot.has(path) && !isScopedMutationAllowed(path, context, "delete")) {
        throw Object.assign(new ConfigurationError(`run_command deleted path outside authorized scope: ${path}`), { code: "TOOL_RESOURCE_FORBIDDEN" });
      }
    }

    if (commandFailure) {
      commandFailure.changed_paths = reconciled.changed_paths;
      commandFailure.active_file_checksums = reconciled.active_file_checksums;
      throw commandFailure;
    }

    logger?.emit?.({
      event_name: "forge.run_command_completed",
      level: commandResult.exit_code === 0 ? "info" : "warn",
      status: "success",
      message: `run_command ${validated.command} completed with exit_code ${commandResult.exit_code}.`,
      task_id: context?.task_id ?? context?.taskId ?? "RUN-COMMAND",
      correlation_id: context?.correlation_id,
      source: "run-command-tool",
      payload: {
        command: validated.command,
        exit_code: commandResult.exit_code,
        duration_ms: commandResult.duration_ms,
        delta_files: reconciled.delta_paths.length
      }
    });

    return {
      ...commandResult,
      changed_paths: reconciled.changed_paths,
      active_file_checksums: reconciled.active_file_checksums,
      ...(reconciled.deleted_paths.length ? { deleted_paths: reconciled.deleted_paths } : {})
    };
  }
}
