// Conversation-originated Architecture Plan creation and update owned by Node.
// Business purpose: an owner can start or revise architecture planning from ordinary
// conversation without typing a path, hash or slash command. Node classifies the
// standalone imperative trigger outside questions, quotes and code fences, invokes the
// Architecture Manager for JSON only, validates that JSON against the Architecture Plan
// schema, writes one immutable Node-owned canonical JSON source anchor per revision
// under the existing plan runtime area, and locks the revision through the unchanged
// Markdown plan store, so approval and Sprint Leader handoff contracts keep working.
// Only Node creates revisions and appends the authoritative owner-decision record; a
// mixed create/update-plus-approve message never approves anything.
// Technical description: clarification discovery and authenticated /plan-continue
// recovery reuse the existing durable clarification session store, so an outstanding
// owner-level decision pauses creation with no revision at all. The canonical anchor
// keeps the existing SUMMARY snapshot gate: summary_path points at the revision anchor
// and summary_sha256 is the exact-byte SHA-256 Node generated for it. Transport intent
// stays restricted to normal_chat/ticket_create because routing here is Node-side text
// classification, never a new intent value. Prompt prefixes keep the existing
// "Architecture clarification discovery" contract so streaming content types are unchanged.
import { randomUUID } from "node:crypto";
import { architectureSessionFromRecord, canonicalizeArchitecturePlanJSON, mergeArchitecturePlanJSON, parseArchitecturePlanJSON, renderArchitecturePlanMarkdown } from "../modules/governance/architecture-plan-json.js";
import { readConversationPlanSource, retainConversationIntakeSource, retainConversationPlanSource } from "../modules/governance/conversation-plan-source.js";
import { assertNoMixedPlanningApproval, detectPlanCreateTrigger, detectPlanUpdateTrigger, isConversationPlanMessage } from "../modules/governance/conversation-plan-trigger.js";
import { appendArchitectureDecisions, architectureSelections, decisionError, readArchitectureDecisions } from "../modules/governance/architecture-owner-decisions.js";
import { parseArchitectureQuestions } from "../modules/governance/architecture-question-response.js";

const INTAKE_PATH_RE = /\/plans\/(PLAN-[A-Za-z0-9._-]+)\/conversation-intake\.json$/;
const ANCHOR_PATH_RE = /\/plans\/(PLAN-[A-Za-z0-9._-]+)\/plan-source-r(\d+)\.json$/;

// Recovers the Node-owned plan identity embedded in a conversation intake anchor path.
export function planIdFromIntakePath(sourcePath) { return String(sourcePath ?? "").match(INTAKE_PATH_RE)?.[1] ?? null; }

// Re-exports the shared conversation planning predicate for transport and command callers.
export { isConversationPlanMessage };

// Rebuilds a Node session view from an existing revision's authoritative decision record.
function carriedSession(previousMarkdown) {
  const record = readArchitectureDecisions(previousMarkdown);
  return record?.decisions?.length ? architectureSessionFromRecord(record) : null;
}

// Creates one resumable conversation planning workflow bound to a project's plan stores.
export function createConversationPlanningService({ projectId, fileService, markdownPlanStore, validateMarkdown, sessions, requestArchitecture } = {}) {
  if (!projectId || !fileService?.readFile || !markdownPlanStore?.createRevision || typeof validateMarkdown !== "function" || !sessions?.create || typeof requestArchitecture !== "function") throw decisionError("CONVERSATION_PLANNING_UNAVAILABLE", "Conversation planning needs File Service, the Markdown plan store, gates, sessions and Architecture.");

  // Generates revision r1 from conversation context and its Node-generated source anchor.
  async function createFromConversation({ text, conversationId }) {
    assertNoMixedPlanningApproval(text);
    const trigger = detectPlanCreateTrigger(text);
    if (!trigger) throw decisionError("PLAN_TRIGGER_REQUIRED", "No standalone plan create trigger is present; the message stays normal conversation.");
    const planId = `PLAN-${projectId}-${randomUUID()}`;
    const intake = await retainConversationIntakeSource({ fileService, planId, intake: { schema_version: 1, project_id: projectId, conversation_id: conversationId, trigger, text: String(text ?? "") } });
    const questions = parseArchitectureQuestions(String(await requestArchitecture(clarificationPrompt(text), conversationId) ?? "").trim());
    const session = await sessions.create({ sourcePath: intake.path, sourceSha256: intake.sha256, conversationId, questions });
    if (questions.length) return waitingForOwner(session);
    return generate({ session, sourceText: text, planId });
  }

  // Merges one RFC 7396 update into the retained canonical base and locks the next revision.
  async function updateFromConversation({ text, conversationId }) {
    assertNoMixedPlanningApproval(text);
    if (!detectPlanUpdateTrigger(text)) return null;
    const target = markdownPlanStore.list().find((entry) => ANCHOR_PATH_RE.test(entry.source_path ?? ""));
    if (!target) throw decisionError("PLAN_UPDATE_TARGET_MISSING", "There is no conversation-created plan revision to update. Create a plan first.");
    const baseBytes = await readConversationPlanSource({ fileService, path: target.source_path, sha256: target.source_sha256 });
    const patch = String(await requestArchitecture(updatePrompt(text, baseBytes), conversationId) ?? "").trim();
    const merged = mergeArchitecturePlanJSON(baseBytes, patch);
    const revision = target.revision + 1;
    const anchor = await retainConversationPlanSource({ fileService, planId: target.plan_id, revision, canonicalBytes: canonicalizeArchitecturePlanJSON(merged) });
    const baseMarkdown = renderArchitecturePlanMarkdown({ plan: merged, planId: target.plan_id, revision, sourceSha256: anchor.sha256 });
    await validateMarkdown(baseMarkdown);
    const previous = await markdownPlanStore.getRevision({ planId: target.plan_id, revision: target.revision });
    const decisionSession = carriedSession(previous.markdown) ?? { session_id: `${target.plan_id}-R${revision}`, source_path: anchor.path, source_sha256: anchor.sha256, owner_id: null, confirmed_at: null, questions: [], selections: {}, notes: {} };
    const stored = await markdownPlanStore.createRevision({ planId: target.plan_id, expectedRevision: target.revision, markdown: appendArchitectureDecisions(baseMarkdown, decisionSession), summaryPath: anchor.path, summarySha256: anchor.sha256, conversationId });
    return createdResult(stored, decisionSession);
  }

  // Resumes an authenticated /plan-continue clarification and creates exactly one revision.
  async function continuePlan({ sessionId, conversationId, ownerId, expectedVersion, sourceSha256 }) {
    if (!ownerId) throw decisionError("PLAN_OWNER_UNAUTHORIZED", "Owner authentication is required to confirm planning choices.");
    return sessions.claim(sessionId, async (session, save) => {
      if (session.conversation_id !== conversationId || session.source_sha256 !== sourceSha256) throw decisionError("ARCHITECTURE_SESSION_STALE", "Clarification identity differs from the reviewed source or conversation.");
      const sourceText = await fileService.readFile({ path: session.source_path });
      if (!session.questions.length) return generate({ session, sourceText, planId: planIdFromIntakePath(session.source_path) ?? session.plan_id, save });
      if (session.version !== expectedVersion || !["awaiting_owner_decisions", "generation_failed"].includes(session.status)) throw decisionError("ARCHITECTURE_SESSION_STALE", "Reload the latest choices before confirming.");
      const confirmed = await save({ selections: architectureSelections(session.questions, session.selections), owner_id: ownerId, confirmed_at: new Date().toISOString(), confirmation_version: session.version });
      return generate({ session: confirmed, sourceText, planId: planIdFromIntakePath(confirmed.source_path) ?? confirmed.plan_id, save });
    });
  }

  // Locks one revision: Node renders, appends authoritative decisions, then stores anchor-bound bytes.
  async function generate({ session, sourceText, planId, save = null }) {
    const existing = markdownPlanStore.list().find((entry) => entry.plan_id === planId);
    if (existing) {
      const plan = await markdownPlanStore.getRevision({ planId, revision: existing.revision });
      const result = createdResult(plan, session);
      if (save) await save({ status: "completed", result });
      return result;
    }
    const decisions = (session.questions ?? []).map((question) => ({ question: question.title, reason: question.reason, selected: question.options.find((option) => option.id === (session.selections ?? {})[question.id]), owner_note: session.notes?.[question.id] ?? "" }));
    const raw = String(await requestArchitecture(generationPrompt(sourceText, decisions), session.conversation_id ?? "") ?? "").trim();
    const plan = parseArchitecturePlanJSON(raw);
    const anchor = await retainConversationPlanSource({ fileService, planId, revision: 1, canonicalBytes: canonicalizeArchitecturePlanJSON(plan) });
    const baseMarkdown = renderArchitecturePlanMarkdown({ plan, planId, revision: 1, sourceSha256: anchor.sha256 });
    await validateMarkdown(baseMarkdown);
    const stored = await markdownPlanStore.createRevision({ planId, expectedRevision: 0, markdown: appendArchitectureDecisions(baseMarkdown, session), summaryPath: anchor.path, summarySha256: anchor.sha256, conversationId: session.conversation_id ?? null });
    const result = createdResult(stored, session);
    if (save) await save({ status: "completed", result });
    return result;
  }

  // Saves explicit draft owner choices so an authenticated continuation can confirm them later.
  async function saveClarificationChoices({ sessionId, expectedVersion, sourceSha256, selections, notes = {} }) {
    return sessions.update(sessionId, { expectedVersion, sourceSha256, selections, notes });
  }

  return Object.freeze({ createFromConversation, updateFromConversation, continuePlan, saveClarificationChoices });
}

// Presents a clarification pause as a successful non-creation with no plan revision.
function waitingForOwner(session) {
  return { command: "/plan", status: "awaiting_owner_decisions", session_id: session.session_id, conversation_id: session.conversation_id, source_summary_path: session.source_path, source_summary_sha256: session.source_sha256, plan_id: planIdFromIntakePath(session.source_path), text: `Architecture cần owner chốt ${session.questions.length} quyết định trước khi tạo plan. Chưa lưu revision.`, run_started: false, revision_created: false };
}

// Returns the authoritative identity, rendered Markdown and review status for one locked revision.
function createdResult(plan, session) {
  return { command: "/plan", status: plan.status ?? "awaiting_human_approval", session_id: session?.session_id ?? null, plan_id: plan.plan_id, revision: plan.revision, sha256: plan.sha256, file_id: plan.plan_id, path: plan.file_path, source_summary_path: plan.source_path, source_summary_sha256: plan.source_sha256, conversation_id: plan.conversation_id, markdown: plan.markdown, text: `Đã tạo plan ${plan.plan_id} r${plan.revision}. Vào trang Coding để xem và approve plan. Chưa RUN.`, run_started: false, revision_created: true };
}

const PLAN_JSON_SHAPE = '{"title":"","objective":"","background":"","scope":[""],"outcomes":[{"id":"O1","outcome":"","acceptance_criteria":[""],"guardrails":[""]}],"evidence":[{"path":"backend/src/example.js","location":"L1","fact":""}],"assumptions":[""],"constraints":[""],"risks":[""],"verification":""}';

// Builds the owner-decision discovery instruction that keeps the existing prompt contract.
function clarificationPrompt(sourceText) {
  return `Architecture clarification discovery, not plan generation. Read the conversation and inspect the repository before deciding what actually needs owner authority. Respect decisions already stated: never ask them again. Ask only unresolved owner-level changes to system boundaries, business scope, security/data policy or explicit owner guardrails. Return ONLY JSON {"questions":[{"id":"STORAGE","title":"Question","reason":"Why the owner must decide","options":[{"id":"LOCAL","label":"Local storage","description":"Device-local persistence"},{"id":"SERVER","label":"Server storage","description":"Server persistence with access control"}],"recommended_option_id":"LOCAL"}]}, 2-10 alternatives each, or {"questions":[]} when none are needed. Do not draft a plan, persist files, claim approval or dispatch work.\n\nOwner conversation:\n${sourceText}`;
}

// Builds the strict full-plan JSON instruction so only AM supplies plan content.
function generationPrompt(sourceText, decisions) {
  return `Architecture plan generation. Complete repository discovery first, then return ONLY one JSON object matching this shape: ${PLAN_JSON_SHAPE}. Do not return Markdown, prose, comments, approval claims, file writes or RUN claims. Every repository fact needs an evidence entry with a real path under backend/, schemas/, ui/, web/, docs/ or workflows/, and assumptions stay explicit. Apply ALL confirmed owner policies consistently and never re-ask them. Node alone validates, locks the revision and appends the authoritative owner decision record.${decisions?.length ? `\n\nConfirmed owner decisions:\n${JSON.stringify(decisions)}` : ""}\n\nOwner conversation:\n${sourceText}`;
}

// Builds the RFC 7396 merge-patch instruction against the retained canonical base.
function updatePrompt(sourceText, baseJson) {
  return `Architecture plan update. Return ONLY one JSON RFC 7396 merge patch against the canonical plan below: changed fields carry new values, removed nested fields use null, untouched fields are omitted, and no root required field may be null. Do not return Markdown, prose, approval claims, file writes or RUN claims. Node alone merges, revalidates the full schema, and locks the next revision.\n\nCanonical plan:\n${baseJson}\n\nOwner conversation:\n${sourceText}`;
}
