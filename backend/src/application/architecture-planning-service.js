// Coordinates Architecture discovery, explicit owner clarification and source-bound Markdown generation before Sprint handoff.
import { createHash } from "node:crypto";
import { createArchitectureClarificationStore } from "./architecture-clarification-store.js";
import { appendArchitectureDecisions, architectureSelections, decisionError, readArchitectureDecisions } from "../modules/governance/architecture-owner-decisions.js";
import { parseArchitectureQuestions } from "../modules/governance/architecture-question-response.js";
import { generateValidatedArchitecturePlan } from "./architecture-plan-generation.js";

// Creates a resumable planning workflow; owner choices and plan approval remain separate operations.
export function createArchitecturePlanningService({ projectId, fileService, markdownPlanStore, validateMarkdown, framePath }) {
  const sessions = createArchitectureClarificationStore({ projectId, fileService });
  return { sessions, start, resume };

  // Discovers only unresolved owner-level tradeoffs and releases the agent while waiting for answers.
  async function start({ sourcePath, conversationId, requestArchitecture }) {
    if (!/^[A-Za-z0-9_./-]+\.md$/i.test(sourcePath ?? "") || sourcePath.startsWith("/") || sourcePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) throw decisionError("PLAN_SOURCE_PATH_INVALID", "Use a project-relative Markdown file without traversal.");
    const summary = await fileService.readFile({ path: sourcePath }).catch((error) => { throw decisionError("SUMMARY_NOT_FOUND", `Summary is unavailable: ${error.code ?? error.name}.`); });
    if (typeof summary !== "string" || !summary.trim()) throw decisionError("SUMMARY_SOURCE_INVALID", "Planning input must not be empty.");
    if (typeof requestArchitecture !== "function") throw decisionError("ARCHITECTURE_UNAVAILABLE", "Architecture is unavailable.");
    const frame = await fileService.readFile({ path: framePath }).catch((error) => { throw decisionError("PLAN_FRAME_NOT_FOUND", `Architecture rules are unavailable: ${error.code ?? error.name}.`); });
    const raw = String(await requestArchitecture(`Architecture clarification discovery, not plan generation. Read the source and inspect the repository before deciding what actually needs owner authority. Respect decisions already stated in the source: never ask them again. Decide delegated technical details yourself. Ask only unresolved business, storage/privacy, lifecycle or scope tradeoffs. Return ONLY JSON {"questions":[{"id":"STORAGE","title":"Question","reason":"Why the owner must decide","options":[{"id":"LOCAL","label":"Local storage","description":"Device-local persistence without cross-device sync"},{"id":"SERVER","label":"Server storage","description":"Account-bound persistence with access control and cross-device sync"}],"recommended_option_id":"LOCAL"}]}. Each question needs 2-10 alternatives. Use the owner's language. Return {"questions":[]} when no owner decisions are needed. Do not draft a plan, persist files, claim approval or dispatch work.\n\nSource (${sourcePath}):\n${summary}\n\nArchitecture rules:\n${frame}`, conversationId) ?? "").trim();
    const questions = parseArchitectureQuestions(raw);
    const session = await sessions.create({ sourcePath, sourceSha256: createHash("sha256").update(summary).digest("hex"), conversationId, questions });
    await sessions.source(session);
    if (questions.length) return waiting(session);
    return sessions.claim(session.session_id, (current, save) => generate(current, save, requestArchitecture));
  }

  // Confirms authenticated owner choices for the exact session version and resumes only that planning request.
  async function resume({ sessionId, conversationId, ownerId, expectedVersion, sourceSha256, requestArchitecture }) {
    if (!ownerId) throw decisionError("PLAN_OWNER_UNAUTHORIZED", "Owner authentication is required to confirm planning choices.");
    return sessions.claim(sessionId, async (session, save) => {
      if (session.conversation_id !== conversationId || session.source_sha256 !== sourceSha256) throw decisionError("ARCHITECTURE_SESSION_STALE", "Clarification identity differs from the reviewed source or conversation.");
      if (!session.questions.length && ["ready", "generating"].includes(session.status) && session.version === expectedVersion) return generate(session, save, requestArchitecture);
      if (session.confirmation_version === expectedVersion && session.owner_id === ownerId && ["completed", "generation_failed", "generating"].includes(session.status)) {
        if (session.status === "completed") return session.result;
        return generate(session, save, requestArchitecture);
      }
      if (session.version !== expectedVersion || !["awaiting_owner_decisions", "generation_failed"].includes(session.status)) throw decisionError("ARCHITECTURE_SESSION_STALE", "Reload the latest choices before confirming.");
      const selections = architectureSelections(session.questions, session.selections);
      await sessions.source(session);
      const confirmed = await save({ selections, owner_id: ownerId, confirmed_at: new Date().toISOString(), confirmation_version: session.version });
      return generate(confirmed, save, requestArchitecture);
    });
  }

  // Generates one immutable plan including Node's decision record, with retry reconciliation after a lost response.
  async function generate(session, save, requestArchitecture) {
    try {
      const existing = markdownPlanStore.list().find((plan) => plan.plan_id === session.plan_id);
      if (existing) {
        const plan = await markdownPlanStore.getRevision({ planId: existing.plan_id, revision: existing.revision });
        const expected = readArchitectureDecisions(appendArchitectureDecisions("", session));
        if (JSON.stringify(readArchitectureDecisions(plan.markdown)) !== JSON.stringify(expected)) throw decisionError("ARCHITECTURE_DECISIONS_INVALID", "Recovered plan does not match the confirmed owner choices.");
        const result = resultFor(plan, session);
        await save({ status: "completed", result });
        return result;
      }
      const summary = await sessions.source(session);
      const frame = await fileService.readFile({ path: framePath });
      if (typeof requestArchitecture !== "function") throw decisionError("ARCHITECTURE_UNAVAILABLE", "Architecture is unavailable.");
      await save({ status: "generating", process_pid: process.pid, error_code: null });
      const decisions = session.questions.map((question) => ({ question: question.title, reason: question.reason, selected: question.options.find((option) => option.id === session.selections[question.id]), owner_note: session.notes[question.id] ?? "" }));
      const prompt = `Based on the source summary and plan frame below, complete repository discovery before drafting. Return only Markdown following the frame; do not return JSON, create files, claim approval, or claim RUN. Every repository fact needs [Evidence: repository/path] or [Source: repository/path] referring to a file you read under backend/, schemas/, ui/, web/, docs/ or workflows/. Include an explicit Repository discovery complete statement and label assumptions or unverified areas. Apply ALL confirmed owner policies consistently to scope, constraints and acceptance criteria. Do not ask these decisions again, contradict them, or turn them into pending owner prerequisites. Decide delegated implementation details yourself. If a genuine unresolved authority conflict makes this impossible, return no plan and explain the conflict instead of inventing approval. Node appends the authoritative owner decision record; do not emit a nodeforge-owner-decisions block.\n\nConfirmed owner decisions:\n${JSON.stringify(decisions)}\n\n## Source Summary (${session.source_path})\n\n${summary}\n\n## Plan Frame (${framePath})\n\n${frame}`;
      const planMarkdown = await generateValidatedArchitecturePlan({ prompt, conversationId: session.conversation_id, requestArchitecture, validateMarkdown, assertSource: () => sessions.source(session) });
      await sessions.source(session);
      const plan = await markdownPlanStore.createRevision({ planId: session.plan_id, markdown: appendArchitectureDecisions(planMarkdown, session), summaryPath: session.source_path, summarySha256: session.source_sha256, conversationId: session.conversation_id });
      const result = resultFor(plan, session);
      await save({ status: "completed", result });
      return result;
    } catch (error) {
      await save({ status: "generation_failed", error_code: error.code ?? "PLAN_GENERATION_FAILED" });
      throw error;
    }
  }
}

// Presents waiting as a successful pause rather than a failed generation or a ticket Human Review gate.
function waiting(session) {
  return { command: "/plan", status: "awaiting_owner_decisions", session_id: session.session_id, conversation_id: session.conversation_id, source_summary_path: session.source_path, source_summary_sha256: session.source_sha256, text: `Architecture cần owner chốt ${session.questions.length} quyết định trước khi tạo plan.`, run_started: false };
}

// Returns the persisted plan identity without approving it or launching Sprint Leader.
function resultFor(plan, session) {
  return { command: "/plan", status: plan.status, session_id: session.session_id, plan_id: plan.plan_id, revision: plan.revision, sha256: plan.sha256, file_id: plan.plan_id, path: plan.file_path, source_summary_path: session.source_path, source_summary_sha256: session.source_sha256, conversation_id: session.conversation_id, text: `Đã tạo plan ${plan.plan_id}. Vào trang Coding để xem và approve plan. Chưa RUN.`, run_started: false };
}
