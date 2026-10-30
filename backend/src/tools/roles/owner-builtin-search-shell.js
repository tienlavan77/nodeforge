// Restricts owner SDK shell discovery to read-only project search commands.
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { isAbsolute, relative, resolve, sep } from "node:path";

const execFile = promisify(execFileCallback);
const MAX_OUTPUT = 128_000;
const FORBIDDEN_ARGUMENTS = /^(?:--pre(?:=.*)?|--pre-glob(?:=.*)?|--file(?:=.*)?|-f(?!F)\S*|--follow|-L|-exec(?:dir)?|-delete|-ok(?:dir)?|-fprint|-fprintf|-fls|-files0-from)$/;

// Runs only bounded rg/find discovery inside the project for the OpenAI Shell tool.
export function createOwnerBuiltinSearchShell({ projectRoot, logger = () => {} }) {
  const root = resolve(projectRoot);
  return Object.freeze({ run });

  // Executes validated search commands without invoking a shell interpreter.
  async function run(action = {}) {
    if (!Array.isArray(action.commands) || !action.commands.length || action.commands.length > 4) throw new Error("Search shell accepts one to four read-only search commands.");
    const output = [];
    for (const command of action.commands) {
      const started = Date.now();
      let executable;
      let args;
      try { ({ executable, args } = validateCommand(command, root)); }
      catch (error) { logger({ name: "shell", status: "failed", command: "rejected", error_code: "SEARCH_COMMAND_FORBIDDEN" }); throw error; }
      logger({ name: "shell", status: "started", command: executable });
      try {
        const result = await execFile(executable, args, { cwd: root, timeout: 15_000, maxBuffer: MAX_OUTPUT, windowsHide: true });
        const stdout = String(result.stdout ?? "").slice(0, MAX_OUTPUT);
        const stderr = String(result.stderr ?? "").slice(0, MAX_OUTPUT);
        logger({ name: "shell", status: "success", command: executable, duration_ms: Date.now() - started, output_bytes: Buffer.byteLength(stdout), output_sha256: digest(stdout) });
        output.push({ stdout, stderr, outcome: { type: "exit", exitCode: 0 } });
      } catch (error) {
        const stdout = String(error.stdout ?? "").slice(0, MAX_OUTPUT);
        const stderr = String(error.stderr ?? error.message ?? "Search command failed.").slice(0, MAX_OUTPUT);
        const timedOut = error.killed === true;
        const noMatches = executable === "rg" && error.code === 1;
        logger({ name: "shell", status: noMatches ? "success" : "failed", command: executable, duration_ms: Date.now() - started, exit_code: Number.isInteger(error.code) ? error.code : null, output_bytes: Buffer.byteLength(stdout), output_sha256: digest(stdout) });
        output.push({ stdout, stderr, outcome: timedOut ? { type: "timeout" } : { type: "exit", exitCode: Number.isInteger(error.code) ? error.code : 1 } });
      }
    }
    return { output, maxOutputLength: MAX_OUTPUT };
  }
}

// Hashes returned search output without writing source text into logs.
function digest(value) { return createHash("sha256").update(value).digest("hex"); }

// Accepts rg/find only and rejects shell composition, unsafe options, and paths outside the project.
function validateCommand(command, root) {
  if (typeof command !== "string" || !command.trim() || command.length > 4_000 || /[\n\r;|&><`$]/.test(command)) throw new Error("Only a single rg or find search command is allowed.");
  const args = tokenize(command);
  const executable = args.shift();
  if (!["rg", "find"].includes(executable) || !args.length || args.some((argument) => FORBIDDEN_ARGUMENTS.test(argument))) throw new Error("Search shell allows rg or read-only find commands only.");
  for (const argument of args) {
    if (argument.split(/[\\/]/).includes("..")) throw new Error("Search paths must stay inside the project.");
    if (isAbsolute(argument)) {
      const target = resolve(argument);
      const path = relative(root, target);
      if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error("Search paths must stay inside the project.");
    }
  }
  return { executable, args };
}

// Splits simple quoted command arguments without enabling shell expansion or operators.
function tokenize(command) {
  const words = [];
  let value = "";
  let quote = "";
  for (const character of command.trim()) {
    if (quote) { if (character === quote) quote = ""; else value += character; }
    else if (character === "'" || character === '"') quote = character;
    else if (/\s/.test(character)) { if (value) { words.push(value); value = ""; } }
    else value += character;
  }
  if (quote) throw new Error("Search command has an unterminated quote.");
  if (value) words.push(value);
  return words;
}
