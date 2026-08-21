import { appendFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createProjectCommandExecutor } from "../verification/command-executor.js";
import { ConfigurationError } from "../../shared/errors.js";

const DEFAULT_ALLOWED = ["npm", "node", "npx", "git"];
const REVIEWER_COMMANDS = [/^git\s+(status|diff)(\s|$)/, /^npm\s+(test|run\s+(lint|typecheck|validate:schemas|build:web))(\s|$)/, /^node\s+--check\s+[^;&|`$<>\n\r]+$/];

// Executes only explicitly approved, project-scoped development commands.
export function createTerminalToolBridge({ projectRoot, role = "builder", allowedCommands = DEFAULT_ALLOWED, timeoutMs = 120000, approve = async () => false, logger = console, auditFile } = {}) {
  if (typeof projectRoot !== "string" || !projectRoot) throw new ConfigurationError("Terminal bridge requires a project root.");
  if (!Array.isArray(allowedCommands) || !allowedCommands.length) throw new ConfigurationError("Terminal bridge requires an allowlist.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new ConfigurationError("Terminal bridge timeout must be positive.");
  const root = resolve(projectRoot);
  const execute = createProjectCommandExecutor({ projectRoot: root });
  return Object.freeze({ run });

  async function run({ command, approval = false, reason = "" } = {}) {
    const id = `CMD-${randomUUID()}`;
    validateCommand(command);
    if (!approval || !(await approve({ id, command, reason }))) {
      await audit({ id, command, status: "denied", reason });
      throw new ConfigurationError("Terminal command requires owner approval.");
    }
    const started = Date.now();
    const result = await execute(command, { timeoutMs });
    await audit({ id, command, status: result.timedOut ? "timeout" : result.exitCode === 0 ? "completed" : "failed", duration_ms: Date.now() - started, exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr });
    return Object.freeze({ id, ...result });
  }

  function validateCommand(command) {
    if (typeof command !== "string" || !command.trim()) throw new ConfigurationError("Terminal command is required.");
    if (/[;&|`$<>\n\r]/.test(command)) throw new ConfigurationError("Terminal command contains disallowed shell operators.");
    const executable = command.trim().split(/\s+/)[0];
    if (!allowedCommands.includes(executable)) throw new ConfigurationError(`Command is not allowlisted: ${executable}.`);
    if (role === "reviewer" && !REVIEWER_COMMANDS.some((pattern) => pattern.test(command.trim()))) throw new ConfigurationError("Reviewer terminal access is read-only; command is not permitted.");
    const cwd = resolve(root);
    if (relative(root, cwd).startsWith("..")) throw new ConfigurationError("Terminal cwd must stay within project root.");
  }

  async function audit(entry) {
    logger.info?.("Terminal tool", { ...entry, projectRoot: root });
    if (auditFile) await appendFile(auditFile, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, "utf8");
  }
}

export function createReviewerTerminalToolBridge(options = {}) {
  return createTerminalToolBridge({ ...options, role: "reviewer" });
}
