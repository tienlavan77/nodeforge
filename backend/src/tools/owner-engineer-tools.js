// Provides direct System Engineer verification and Git operations through Node-owned project services.
import { ConfigurationError } from "../shared/errors.js";

const CHECK_TYPES = new Set(["test", "lint", "typecheck", "build"]);
const INTERNAL_WORKFLOW_PATH = /^workflows(?:\/|$)/;

// Creates project-service tools that let System Engineer verify, commit, and push project work.
export function createOwnerEngineerTools({ testService, gitService, conversationStateStore } = {}) {
  const implementations = {};
  const definitions = [];
  if (typeof testService?.runCheck === "function") {
    implementations.run_check = { execute: runCheck };
    definitions.push(runCheckDefinition);
  }
  if (gitService?.commit && conversationStateStore?.get && conversationStateStore?.update) {
    implementations.commit_changes = { execute: commitChanges };
    definitions.push(commitChangesDefinition);
  }
  if (gitService?.pushCommit && conversationStateStore?.get) {
    implementations.push_commit = { execute: pushCommit };
    definitions.push(pushCommitDefinition);
  }
  return { definitions, implementations };

  // Runs one explicitly scoped project check to completion and returns its result.
  async function runCheck(input = {}, context = {}) {
    validateKeys(input, ["type", "command"]);
    if (!CHECK_TYPES.has(input.type)) throw invalid("run_check requires type test, lint, typecheck, or build.");
    validateCheckCommand(input.command, input.type);
    const conversationId = ownerConversationId(context);
    const state = await conversationStateStore?.get?.(conversationId);
    const changedPaths = [...new Set([...(state?.owner_changed_paths ?? []), ...(context.changed_paths ?? [])])].sort();
    const result = await testService.runCheck({ commitId: ownerRunId(context), taskId: conversationId, sessionId: context.correlation_id, type: input.type, command: input.command, signal: context.abortSignal });
    return { ...result, changed_paths: changedPaths };
  }

  // Commits only paths recorded by successful Forge writes in this conversation.
  async function commitChanges(input = {}, context = {}) {
    validateKeys(input, ["message"]);
    if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 200) throw invalid("commit_changes requires a message of 1–200 characters.");
    const state = await conversationStateStore.get(ownerConversationId(context));
    const recordedPaths = [...new Set(state?.owner_changed_paths ?? [])].sort();
    const internalPaths = recordedPaths.filter((path) => INTERNAL_WORKFLOW_PATH.test(path));
    const paths = recordedPaths.filter((path) => !INTERNAL_WORKFLOW_PATH.test(path));
    if (!paths.length) throw invalid("No committable files changed through this conversation's Forge tools; workflows documents remain local.", "COMMIT_SCOPE_EMPTY");
    const result = await gitService.commit(input.message.trim(), { paths });
    await conversationStateStore.update(ownerConversationId(context), { owner_changed_paths: internalPaths, owner_last_commit_sha: result.sha, owner_last_commit_paths: paths });
    context.changed_paths = [...new Set([...internalPaths, ...(context.changed_paths ?? []).filter((path) => INTERNAL_WORKFLOW_PATH.test(path))])].sort();
    return { ...result, paths };
  }

  // Pushes only the latest commit recorded by this conversation to the configured project remote.
  async function pushCommit(input = {}, context = {}) {
    validateKeys(input, ["commit_sha"]);
    if (typeof input.commit_sha !== "string" || !/^[a-f0-9]{40,64}$/i.test(input.commit_sha)) throw invalid("push_commit requires a full commit SHA.");
    const state = await conversationStateStore.get(ownerConversationId(context));
    if (state?.owner_last_commit_sha !== input.commit_sha) throw invalid("push_commit only accepts the commit created by this conversation.", "PUSH_COMMIT_SCOPE_INVALID");
    return gitService.pushCommit(input.commit_sha);
  }
}

const runCheckDefinition = definition("run_check", "Run one explicitly scoped check through the Node Verification Service and return its final result.", {
  type: "object", additionalProperties: false, required: ["type", "command"], properties: {
    type: { type: "string", enum: ["test", "lint", "typecheck", "build"] },
    command: { type: "string", minLength: 1, maxLength: 1000, description: "Required focused project check. Specify changed test/file paths; no shell chaining, substitutions, or absolute paths." }
  }
});
const commitChangesDefinition = definition("commit_changes", "Commit only files changed through this conversation's Forge edit tools, excluding internal workflows documents.", {
  type: "object", additionalProperties: false, required: ["message"], properties: { message: { type: "string", minLength: 1, maxLength: 200 } }
});
const pushCommitDefinition = definition("push_commit", "Push the exact commit created by commit_changes to the configured project remote.", {
  type: "object", additionalProperties: false, required: ["commit_sha"], properties: { commit_sha: { type: "string", pattern: "^[a-fA-F0-9]{40,64}$" } }
});

// Binds a stable Forge name and JSON Schema to the same provider-neutral tool contract.
function definition(name, description, inputSchema) { return Object.freeze({ name, description, input_schema: inputSchema }); }

// Restricts shell syntax and executables before delegating the check to Node's verification service.
function validateCheckCommand(command, type) {
  if (typeof command !== "string" || !command.trim() || /[\0\r\n;&|<>`$]/.test(command) || /(^|\s)(?:\/|[A-Za-z]:\\)/.test(command) || /(^|\s)\.\.(?:\/|\s|$)/.test(command)) throw invalid("Check command contains shell syntax or a path outside the project.");
  const allowed = /^(?:node --test(?:\s|$)|pnpm (?:test|lint|typecheck|build|validate:schemas|exec (?:eslint|tsc|vitest|jest|mocha)(?:\s|$)|--filter [A-Za-z0-9@/._-]+ (?:test|lint|typecheck|build)(?:\s|$)|--dir [A-Za-z0-9._/-]+ (?:build|run (?:test|lint|typecheck|build))(?:\s|$))|npm (?:test|run (?:test|lint|typecheck|build|validate:schemas)(?:\s|$)))/;
  if (!allowed.test(command.trim())) throw invalid("Check command must use an approved Node, pnpm, or npm project check.");
  if (type === "test" && /^(?:pnpm test|npm test|node --test)$/i.test(command.trim())) throw invalid("Specify test file paths; run_check does not start the full project suite by default.");
  if (type === "lint" && /^(?:pnpm lint|npm run lint)$/i.test(command.trim())) throw invalid("Specify changed file paths for lint; run_check does not lint the full project by default.");
}

// Rejects unexpected fields so each tool receives only its documented input contract.
function validateKeys(input, keys) { if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))) throw invalid(`Tool input accepts only: ${keys.join(", ")}.`); }

// Builds a stable owner-run key without placing user command text in logs or artifacts.
function ownerRunId(context) { return `OWNER-${ownerConversationId(context)}-${String(context.correlation_id ?? "RUN").replace(/[^A-Za-z0-9._-]/g, "_")}`; }

// Resolves the persistent owner conversation used to scope jobs and file changes.
function ownerConversationId(context) { const id = context.conversation_id ?? context.conversationId; if (typeof id !== "string" || !id) throw invalid("System Engineer tool requires its conversation_id.", "TOOL_SCOPE_INVALID"); return id; }

// Returns a typed tool failure with a stable code for logs and provider responses.
function invalid(message, code = "INPUT_INVALID") { return Object.assign(new ConfigurationError(message), { code }); }
