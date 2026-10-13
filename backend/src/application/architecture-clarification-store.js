// Persists source-bound Architecture questions and owner draft answers across reloads without keeping an agent running.
import { createHash, randomUUID } from "node:crypto";
import { acquireTicketFileLock } from "../modules/supervisor/ticket-file-lock.js";
import { architectureSelections, decisionError, validateArchitectureQuestions } from "../modules/governance/architecture-owner-decisions.js";
const PROCESS_ID = randomUUID();

// Creates durable clarification sessions isolated to one project and conversation.
export function createArchitectureClarificationStore({ projectId, fileService }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectId ?? "")) throw decisionError("PROJECT_CONTEXT_CONFLICT", "Clarification storage requires a safe project identity.");
  const root = `.forge/runtime/nf/plan-clarifications/${projectId}`;
  const indexPath = `${root}/index.json`;
  return { create, get, list, update, source, claim };

  // Saves discovered questions before returning a non-failure waiting state to chat.
  async function create({ sourcePath, sourceSha256, conversationId, questions }) {
    const session = { session_id: `CLARIFY-${randomUUID()}`, plan_id: `PLAN-${projectId}-${randomUUID()}`, project_id: projectId, conversation_id: conversationId, source_path: sourcePath, source_sha256: sourceSha256, questions: validateArchitectureQuestions(questions), selections: {}, notes: {}, status: questions.length ? "awaiting_owner_decisions" : "ready", version: 1, created_at: new Date().toISOString() };
    await fileService.atomicCreate({ path: `${root}/${session.session_id}.json`, content: JSON.stringify(session) });
    const lock = await acquireTicketFileLock(fileService, `${indexPath}.lock`);
    try {
      const ids = await readIndex();
      await fileService.atomicWrite({ path: indexPath, content: JSON.stringify([...ids, session.session_id]), replace: true });
    } finally { await lock.release(); }
    return session;
  }

  // Loads an exact session without accepting caller-supplied project or conversation provenance.
  async function get(id) {
    if (!/^CLARIFY-[a-f0-9-]{36}$/.test(id ?? "")) throw decisionError("ARCHITECTURE_SESSION_NOT_FOUND", "Clarification request not found.");
    try {
      const session = JSON.parse(await fileService.readFile({ path: `${root}/${id}.json` }));
      if (session.project_id !== projectId || session.session_id !== id) throw decisionError("PROJECT_CONTEXT_CONFLICT", "Clarification belongs to a different project.");
      return session;
    } catch (error) { if (error.code === "ENOENT") throw decisionError("ARCHITECTURE_SESSION_NOT_FOUND", "Clarification request not found."); throw error; }
  }

  // Restores pending choices and detects changed source files without automatically relaunching Architecture.
  async function list(conversationId) {
    const sessions = await Promise.all((await readIndex()).map(get));
    return Promise.all(sessions.filter((session) => session.conversation_id === conversationId).map(async (session) => {
      if (["completed", "cancelled"].includes(session.status)) return session;
      try {
        await source(session);
        if (session.status === "ready") return { ...session, status: "generation_failed", error_code: "ARCHITECTURE_GENERATION_INTERRUPTED" };
        if (session.status === "generating" && session.process_id !== PROCESS_ID) {
          if (!Number.isInteger(session.process_pid) || session.process_pid <= 0 || session.process_pid === process.pid) return { ...session, status: "generation_failed", error_code: "ARCHITECTURE_GENERATION_INTERRUPTED" };
          try { process.kill(session.process_pid, 0); }
          catch (error) { if (error.code === "ESRCH") return { ...session, status: "generation_failed", error_code: "ARCHITECTURE_GENERATION_INTERRUPTED" }; if (error.code !== "EPERM") throw error; }
        }
        return session;
      }
      catch (error) { if (["ARCHITECTURE_SOURCE_CHANGED", "ARCHITECTURE_SOURCE_MISSING"].includes(error.code)) return { ...session, status: "source_changed", error_code: error.code }; throw error; }
    }));
  }

  // Saves explicit draft choices under version control; drafts do not approve a plan.
  async function update(id, { expectedVersion, sourceSha256, selections, notes, cancel = false }) {
    return mutate(id, (session) => {
      if (session.version !== expectedVersion || session.source_sha256 !== sourceSha256) throw decisionError("ARCHITECTURE_SESSION_STALE", "Reload this clarification before changing its choices.");
      if (!["awaiting_owner_decisions", "generation_failed"].includes(session.status)) throw decisionError("ARCHITECTURE_SESSION_LOCKED", "This request no longer accepts draft choices.");
      if (cancel) return { ...session, status: "cancelled" };
      if (!notes || typeof notes !== "object" || Array.isArray(notes) || Object.entries(notes).some(([key, value]) => !session.questions.some((question) => question.id === key) || typeof value !== "string" || value.length > 2000)) throw decisionError("ARCHITECTURE_SELECTION_INVALID", "Notes must belong to this request and be bounded text.");
      return { ...session, selections: architectureSelections(session.questions, selections, { complete: false }), notes: structuredClone(notes), status: "awaiting_owner_decisions", confirmation_version: null, confirmed_at: null, owner_id: null };
    });
  }

  // Rechecks the immutable source basis both before and after provider generation.
  async function source(session) {
    let text;
    try { text = await fileService.readFile({ path: session.source_path }); }
    catch (error) { throw decisionError("ARCHITECTURE_SOURCE_MISSING", `Planning source is unavailable: ${error.code ?? error.name}.`); }
    if (createHash("sha256").update(text).digest("hex") !== session.source_sha256) throw decisionError("ARCHITECTURE_SOURCE_CHANGED", "The input file changed. Run /plan again and review new choices.");
    return text;
  }

  // Serializes confirmation across API retries and server recovery without holding a provider session while waiting for owner.
  async function claim(id, action) {
    await get(id);
    const lock = await acquireTicketFileLock(fileService, `${root}/${id}.generation.lock`);
    try { return await action(await get(id), (patch) => mutate(id, (current) => ({ ...current, ...patch }))); }
    finally { await lock.release(); }
  }

  // Atomically updates one session while keeping concurrent owner answers from overwriting each other.
  async function mutate(id, transform) {
    await get(id);
    const lock = await acquireTicketFileLock(fileService, `${root}/${id}.lock`);
    try {
      const current = await get(id);
      const next = { ...transform(current), version: current.version + 1, updated_at: new Date().toISOString() };
      if (next.status === "generating") next.process_id = PROCESS_ID;
      await fileService.atomicWrite({ path: `${root}/${id}.json`, content: JSON.stringify(next), replace: true });
      return next;
    } finally { await lock.release(); }
  }

  // Reads only the Node-owned index; a missing index means there are no clarification sessions.
  async function readIndex() {
    try { return JSON.parse(await fileService.readFile({ path: indexPath })); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
}
