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
import { createHash, randomUUID } from "node:crypto";
import { architectureSessionFromRecord, canonicalArchitecturePlanSha256, canonicalizeArchitecturePlanJSON, mergeArchitecturePlanJSON, parseArchitecturePlanJSON, renderArchitecturePlanMarkdown } from "../modules/governance/architecture-plan-json.js";
import { readConversationPlanSource, readRetainedConversationPlanSource, retainConversationIntakeSource, retainConversationPlanSource } from "../modules/governance/conversation-plan-source.js";
import { assertNoMixedPlanningApproval, detectPlanUpdateTrigger, isConversationPlanMessage, parseConversationPlanCreateTrigger } from "../modules/governance/conversation-plan-trigger.js";
import { appendArchitectureDecisions, architectureSelections, decisionError, readArchitectureDecisions } from "../modules/governance/architecture-owner-decisions.js";
import { parseArchitectureQuestions } from "../modules/governance/architecture-question-response.js";
import { formatDiscoveryCompactReceipt } from "./owner-context-compaction.js";

const INTAKE_PATH_RE = /\/plans\/(PLAN-[A-Za-z0-9._-]+)\/conversation-intake\.json$/;
const ANCHOR_PATH_RE = /\/plans\/(PLAN-[A-Za-z0-9._-]+)\/plan-source-r(\d+)\.json$/;
const SAFE_MD_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[\\\0])[A-Za-z0-9._/-]+\.md$/i;

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
export function createConversationPlanningService({ projectId, fileService, markdownPlanStore, validateMarkdown, sessions, requestArchitecture, conversationStateStore, communications, maxSelfHealAttempts = 2 } = {}) {
  if (!projectId || !fileService?.readFile || !markdownPlanStore?.createRevision || typeof validateMarkdown !== "function" || !sessions?.create || typeof requestArchitecture !== "function") throw decisionError("CONVERSATION_PLANNING_UNAVAILABLE", "Conversation planning needs File Service, the Markdown plan store, gates, sessions and Architecture.");
  const maxRetries = Number.isInteger(maxSelfHealAttempts) && maxSelfHealAttempts >= 0 ? maxSelfHealAttempts : 2;

  // Business purpose: extracts the readable text body from either a standard conversation message or a System Engineer SDK conversation_turn activity snapshot so marked ideas can be fed into plan generation.
  // Technical description: inspects payload.sdk_event.entries when the message is a system_engineer conversation_turn activity, otherwise returns trimmed payload.text or payload.content.
  function extractMessageText(message) {
    const payload = message?.payload ?? {};
    if (message?.message_type === "agent.activity" && payload.agent_role === "system_engineer" && payload.sdk_event?.type === "conversation_turn") {
      return (payload.sdk_event.entries ?? []).filter((entry) => entry.type === "text" && typeof entry.text === "string").map((entry) => entry.text).join("\n").trim();
    }
    return String(payload.text ?? payload.content ?? "").trim();
  }

  // Business purpose: strips standalone plan creation trigger lines from follow-up conversation text so the plan command itself is not duplicated into an idea's context.
  // Technical description: splits text by line, removes lines that match parseConversationPlanCreateTrigger, and returns the trimmed remainder.
  function stripTriggerLines(rawText) {
    return String(rawText ?? "").split(/\r?\n/).filter((line) => !parseConversationPlanCreateTrigger(line)).join("\n").trim();
  }

  // Business purpose: retrieves conversation history, identifies each marked agent idea in chronological order, and groups subsequent related exchanges into the corresponding idea before plan creation.
  // Technical description: queries direct and linked conversation messages from communications, deduplicates SE turn snapshots, anchors each group on an agent message with payload.is_idea set to true, attaches follow-up messages (with trigger lines stripped) to their active or referenced idea group, and returns ordered idea group descriptors.
  function extractMarkedIdeaGroups(conversationId, triggerText) {
    const direct = conversationId && typeof communications?.getByConversationId === "function"
      ? communications.getByConversationId(conversationId)
      : (typeof communications?.getAll === "function" ? communications.getAll().filter((m) => !conversationId || m.conversation_id === conversationId) : []);
    const linked = conversationId && typeof communications?.getByLinkedConversationId === "function"
      ? communications.getByLinkedConversationId(conversationId).filter((m) => !direct.some((item) => item.id === m.id || (item.correlation_id && item.correlation_id === m.correlation_id)))
      : [];
    const allMessages = [...direct, ...linked].filter((m) => !m.project_id || m.project_id === projectId);
    const seTurnCorrelations = new Set(allMessages.filter((m) => m.message_type === "agent.activity" && m.payload?.sdk_event?.type === "conversation_turn" && m.correlation_id).map((m) => m.correlation_id));
    const ordered = allMessages
      .filter((m) => !(m.message_type === "system_engineer.message.received" && m.correlation_id && seTurnCorrelations.has(m.correlation_id)))
      .sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
    const isOwnerMsg = (m) => m.message_type === "owner.message" || m.sender?.role === "project_owner" || m.sender?.role === "owner";
    const isAgentIdeaMsg = (m) => Boolean(m.payload?.is_idea) && !isOwnerMsg(m) && Boolean(extractMessageText(m));
    const ideaPromptOwnerIds = new Set();
    const ownerByCorrelation = new Map();
    for (const msg of ordered) {
      if (isOwnerMsg(msg) && msg.correlation_id) ownerByCorrelation.set(msg.correlation_id, msg);
    }
    for (const msg of ordered) {
      if (isAgentIdeaMsg(msg) && msg.correlation_id && ownerByCorrelation.has(msg.correlation_id)) {
        ideaPromptOwnerIds.add(ownerByCorrelation.get(msg.correlation_id).id);
      }
    }
    const groups = [];
    for (const msg of ordered) {
      if (isAgentIdeaMsg(msg)) {
        const ideaText = extractMessageText(msg);
        const ownerMsg = msg.correlation_id ? ownerByCorrelation.get(msg.correlation_id) : null;
        const ownerText = ownerMsg ? stripTriggerLines(extractMessageText(ownerMsg)) : "";
        const ideaIndex = groups.length + 1;
        groups.push({ idea_index: ideaIndex, idea_message_id: msg.id, owner_message_id: ownerMsg?.id ?? null, owner_text: ownerText, idea_text: ideaText, follow_ups: [] });
        continue;
      }
      if (!groups.length || ideaPromptOwnerIds.has(msg.id)) continue;
      if (msg.message_type === "owner.command.result" || msg.message_type === "owner.command.error" || String(msg.message_type ?? "").endsWith(".error")) continue;
      const cleaned = stripTriggerLines(extractMessageText(msg));
      if (!cleaned) continue;
      const refMatch = /\b(?:ý\s+tưởng|idea)\s*#?(\d+)\b/i.exec(cleaned);
      const refIndex = refMatch ? Number(refMatch[1]) - 1 : -1;
      const targetGroup = refIndex >= 0 && refIndex < groups.length ? groups[refIndex] : groups[groups.length - 1];
      targetGroup.follow_ups.push({ id: msg.id, role: isOwnerMsg(msg) ? "Owner" : "Agent", text: cleaned });
    }
    const extraTriggerNotes = stripTriggerLines(triggerText);
    return groups.map((group) => {
      const followUpBlock = group.follow_ups.map((item) => `${item.role} (${item.id}):\n${item.text}`).join("\n\n");
      const combined = [
        `--- Marked Idea #${group.idea_index} (${group.idea_message_id}) ---`,
        ...(group.owner_text ? [`Owner Request (${group.owner_message_id}):\n${group.owner_text}`] : []),
        `Agent Idea (${group.idea_message_id}):\n${group.idea_text}`,
        ...(followUpBlock ? [`--- Follow-up Discussion for Idea #${group.idea_index} ---\n${followUpBlock}`] : []),
        ...(extraTriggerNotes ? [`--- Additional Planning Notes ---\n${extraTriggerNotes}`] : [])
      ].join("\n\n");
      return { idea_index: group.idea_index, idea_message_id: group.idea_message_id, owner_message_id: group.owner_message_id, idea_text: group.idea_text, follow_up_count: group.follow_ups.length, combined_text: combined };
    });
  }

  // Business purpose: loads the Discovery Compact Receipt recorded during Phase 1 or earlier repository inspections in the same conversation so Phase 2 and Phase 3 prompts reuse verified file checksums and line ranges.
  // Technical description: reads conversation state from conversationStateStore or session.discovery_receipt and formats it via formatDiscoveryCompactReceipt.
  async function loadDiscoveryReceiptBlock(conversationId, session = null) {
    const state = conversationId ? await conversationStateStore?.get?.(conversationId) : null;
    if (state) {
      const formatted = formatDiscoveryCompactReceipt(state);
      if (formatted) return formatted;
    }
    if (typeof session?.discovery_receipt === "string" && session.discovery_receipt) return session.discovery_receipt;
    if (session?.discovery_receipt && typeof session.discovery_receipt === "object") return formatDiscoveryCompactReceipt(session.discovery_receipt);
    return "";
  }

  // Business purpose: requests Clarification Discovery from Architecture Manager with a bounded self-healing retry loop when the returned JSON question response is malformed or violates the clarification schema.
  // Technical description: attempts parseArchitectureQuestions (with pregeneratedPlan fallback) and retries up to maxRetries times with detailed error diagnostics and the preserved Discovery Compact Receipt.
  async function requestClarificationWithSelfHeal(combinedSourceText, conversationId) {
    let prompt = clarificationPrompt(combinedSourceText);
    let lastRaw = "";
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      lastRaw = String(await requestArchitecture(prompt, conversationId, { responseContentType: "text/plain" }) ?? "").trim();
      try {
        return { questions: parseArchitectureQuestions(lastRaw), pregeneratedPlan: null };
      } catch (clarifyErr) {
        try {
          return { questions: [], pregeneratedPlan: parseArchitecturePlanJSON(lastRaw) };
        } catch {
          if (attempt >= maxRetries) throw clarifyErr;
          const discoveryReceipt = await loadDiscoveryReceiptBlock(conversationId);
          prompt = clarificationRepairPrompt(combinedSourceText, clarifyErr, lastRaw, discoveryReceipt, attempt + 1, maxRetries);
        }
      }
    }
    throw decisionError("ARCHITECTURE_QUESTIONS_INVALID", "Architecture returned malformed question JSON.");
  }

  // Generates revision r1 from conversation context, marked ideas, or a specified Markdown file and its Node-generated source anchor.
  async function createFromConversation({ text, conversationId }) {
    assertNoMixedPlanningApproval(text);
    const parsed = parseConversationPlanCreateTrigger(text);
    if (!parsed) throw decisionError("PLAN_TRIGGER_REQUIRED", "No standalone plan create trigger is present; the message stays normal conversation.");
    if (parsed.source_kind === "marked_ideas") {
      const ideaGroups = extractMarkedIdeaGroups(conversationId, text);
      if (!ideaGroups.length) {
        throw Object.assign(decisionError("PLAN_IDEAS_EMPTY", "Không có ý tưởng nào được đánh dấu trong cuộc trao đổi để tạo kế hoạch. Vui lòng đánh dấu ít nhất một ý tưởng trước khi tạo plan."), { statusCode: 409 });
      }
      const createdPlans = [];
      for (const group of ideaGroups) {
        const planId = `PLAN-${projectId}-${randomUUID()}`;
        const intakeRecord = {
          schema_version: 1, project_id: projectId, conversation_id: conversationId, trigger: parsed.line,
          source_kind: "marked_ideas", idea_index: group.idea_index, idea_message_id: group.idea_message_id,
          ...(group.owner_message_id ? { owner_message_id: group.owner_message_id } : {}),
          delivery_target: parsed.delivery_target, text: group.combined_text
        };
        const intake = await retainConversationIntakeSource({ fileService, planId, intake: intakeRecord });
        const { questions, pregeneratedPlan } = await requestClarificationWithSelfHeal(group.combined_text, conversationId);
        const discoveryReceipt = await loadDiscoveryReceiptBlock(conversationId);
        const session = await sessions.create({ sourcePath: intake.path, sourceSha256: intake.sha256, conversationId, questions, generating: !questions.length, ...(discoveryReceipt ? { discovery_receipt: discoveryReceipt } : {}) });
        const itemResult = questions.length
          ? waitingForOwner(session, intakeRecord)
          : await sessions.claim(session.session_id, (current, save) => generate({ session: discoveryReceipt ? { ...current, discovery_receipt: discoveryReceipt } : current, sourceText: group.combined_text, planId, save, intake: intakeRecord, pregeneratedPlan }));
        createdPlans.push(itemResult);
      }
      if (createdPlans.length === 1) return { ...createdPlans[0], idea_count: 1, plans: createdPlans };
      const primary = createdPlans[0];
      const allCreated = createdPlans.every((item) => item.revision_created);
      const anyCreated = createdPlans.some((item) => item.revision_created);
      const planLabels = createdPlans.map((item) => item.revision_created ? `${item.plan_id} r${item.revision}` : `${item.plan_id} (chờ làm rõ)`).join(", ");
      return {
        ...primary, source_kind: "marked_ideas", delivery_target: parsed.delivery_target, idea_count: createdPlans.length, plans: createdPlans,
        revision_created: anyCreated, status: allCreated ? primary.status : "awaiting_owner_decisions",
        text: `Đã tạo ${createdPlans.length} kế hoạch từ ${createdPlans.length} ý tưởng đã đánh dấu: ${planLabels}. Chưa RUN.`
      };
    }
    let combinedSourceText = String(text ?? "");
    let sourceFileSha256 = null;
    if (parsed.source_kind === "markdown_file") {
      if (!SAFE_MD_PATH_RE.test(parsed.source_path ?? "")) {
        throw Object.assign(decisionError("PLAN_SOURCE_PATH_INVALID", `Plan source path is invalid: ${parsed.source_path ?? ""}.`), { statusCode: 400 });
      }
      let fileContent;
      try { fileContent = await fileService.readFile({ path: parsed.source_path }); }
      catch (error) {
        if (error.code === "ENOENT") throw Object.assign(decisionError("PLAN_SOURCE_MISSING", `Plan source Markdown file does not exist: ${parsed.source_path}.`), { statusCode: 409 });
        throw error;
      }
      if (typeof fileContent !== "string" || !fileContent.trim()) {
        throw Object.assign(decisionError("PLAN_SOURCE_MISSING", `Plan source Markdown file is empty: ${parsed.source_path}.`), { statusCode: 409 });
      }
      sourceFileSha256 = createHash("sha256").update(fileContent, "utf8").digest("hex");
      combinedSourceText = `${combinedSourceText.trim()}\n\n--- Markdown Source (${parsed.source_path}) ---\n${fileContent}`;
    }
    const planId = `PLAN-${projectId}-${randomUUID()}`;
    const intakeRecord = {
      schema_version: 1,
      project_id: projectId,
      conversation_id: conversationId,
      trigger: parsed.line,
      source_kind: parsed.source_kind,
      ...(parsed.source_path ? { source_file_path: parsed.source_path, source_file_sha256: sourceFileSha256 } : {}),
      delivery_target: parsed.delivery_target,
      text: combinedSourceText
    };
    const intake = await retainConversationIntakeSource({ fileService, planId, intake: intakeRecord });
    const { questions, pregeneratedPlan } = await requestClarificationWithSelfHeal(combinedSourceText, conversationId);
    const discoveryReceipt = await loadDiscoveryReceiptBlock(conversationId);
    const session = await sessions.create({ sourcePath: intake.path, sourceSha256: intake.sha256, conversationId, questions, generating: !questions.length, ...(discoveryReceipt ? { discovery_receipt: discoveryReceipt } : {}) });
    if (questions.length) return waitingForOwner(session, intakeRecord);
    return sessions.claim(session.session_id, (current, save) => generate({ session: discoveryReceipt ? { ...current, discovery_receipt: discoveryReceipt } : current, sourceText: combinedSourceText, planId, save, intake: intakeRecord, pregeneratedPlan }));
  }

  // Merges one RFC 7396 update into the retained canonical base and locks the next revision.
  // Business purpose: an owner revises a conversation-created plan inside the same
  // conversation using the exact same schema, merge engine, renderer and Node-owned
  // source-anchor mechanism as creation, so approval and handoff contracts stay identical.
  // Technical description: the base is always the current canonical revision of one plan in
  // this conversation, never another conversation's plan; the AM patch payload is merged and
  // fully revalidated before anything is written, so an invalid or ambiguous answer creates
  // no revision and is answered by asking AM to emit a valid payload instead of Node guessing
  // from the owner prose. The next revision number is fenced by the retained base revision, so
  // a concurrent update on the same base either creates exactly one r<n+1> or reports
  // PLAN_REVISION_CONFLICT without overwriting the accepted revision or source snapshot.
  async function updateFromConversation({ text, conversationId }) {
    assertNoMixedPlanningApproval(text);
    if (!detectPlanUpdateTrigger(text)) return null;
    const target = markdownPlanStore.list().find((entry) => entry.conversation_id === conversationId && ANCHOR_PATH_RE.test(entry.source_path ?? ""));
    if (!target) throw decisionError("PLAN_UPDATE_TARGET_MISSING", "There is no conversation-created plan revision to update. Create a plan first.");
    const baseBytes = await readConversationPlanSource({ fileService, path: target.source_path, sha256: target.source_sha256 });
    const revision = target.revision + 1;
    const { merged, baseMarkdown } = await requestMergedPatch({ text, conversationId, baseBytes, planId: target.plan_id, revision });
    const anchor = await retainFencedPlanSource({ planId: target.plan_id, baseRevision: target.revision, revision, canonicalBytes: canonicalizeArchitecturePlanJSON(merged) });
    const previous = await markdownPlanStore.getRevision({ planId: target.plan_id, revision: target.revision });
    const decisionSession = carriedSession(previous.markdown) ?? { session_id: `${target.plan_id}-R${revision}`, source_path: anchor.path, source_sha256: anchor.sha256, owner_id: null, confirmed_at: null, questions: [], selections: {}, notes: {} };
    const stored = await markdownPlanStore.createRevision({ planId: target.plan_id, expectedRevision: target.revision, markdown: appendArchitectureDecisions(baseMarkdown, decisionSession), summaryPath: anchor.path, summarySha256: anchor.sha256, conversationId });
    return createdResult(stored, decisionSession);
  }

  // Requests the Architecture patch payload and merges it fail-closed before anything persists.
  // Business purpose: an Architecture answer that is not a valid RFC 7396 merge patch must never
  // be guessed into a plan from the owner's prose; Node rejects it, writes no revision, and the
  // rejection text asks Architecture to emit a valid payload for the canonical plan instead.
  // Technical description: the shared merge engine revalidates the whole merged document against
  // the unchanged Architecture Plan schema, so malformed JSON, non-object patches, empty answers,
  // root null deletions and schema violations all fail here before anchor or Markdown writes.
  async function requestMergedPatch({ text, conversationId, baseBytes, planId, revision }) {
    let discoveryReceipt = await loadDiscoveryReceiptBlock(conversationId);
    let prompt = updatePrompt(text, baseBytes, discoveryReceipt);
    let lastRaw = "";
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      lastRaw = String(await requestArchitecture(prompt, conversationId, { responseContentType: "text/plain" }) ?? "").trim();
      try {
        const merged = mergeArchitecturePlanJSON(baseBytes, lastRaw);
        const baseMarkdown = renderArchitecturePlanMarkdown({ plan: merged, planId, revision, sourceSha256: canonicalArchitecturePlanSha256(merged) });
        await validateMarkdown(baseMarkdown);
        return { merged, baseMarkdown };
      } catch (error) {
        const isPatchParseError = error.code === "ARCHITECTURE_PLAN_JSON_INVALID" || error.code === "ARCHITECTURE_PLAN_PATCH_INVALID";
        if (attempt >= maxRetries) {
          console.warn("Conversation plan update rejected before persistence", { code: error.code ?? "ARCHITECTURE_PLAN_JSON_INVALID", conversation_id: conversationId, reason: error.message });
          if (isPatchParseError) {
            throw decisionError("ARCHITECTURE_PLAN_PATCH_INVALID", `Architecture must return a valid RFC 7396 JSON merge patch payload for the canonical plan; Node never infers a plan from conversation text. No revision was created. (${error.message})`);
          }
          throw error;
        }
        discoveryReceipt = await loadDiscoveryReceiptBlock(conversationId) || discoveryReceipt;
        prompt = updateRepairPrompt(text, baseBytes, error, lastRaw, discoveryReceipt, attempt + 1, maxRetries);
      }
    }
    throw decisionError("ARCHITECTURE_PLAN_PATCH_INVALID", "Architecture must return a valid RFC 7396 JSON merge patch payload for the canonical plan.");
  }

  // Locks the next revision anchor behind the retained base so a stale update cannot overwrite it.
  // Business purpose: two concurrent updates read the same current revision, but only one may
  // create the next revision; the other must report PLAN_REVISION_CONFLICT while leaving the
  // accepted revision bytes and its Node-owned source snapshot exactly as the winner stored them.
  // Technical description: the head revision is re-read immediately before anchor retention, and a
  // revision anchor already holding different canonical bytes is reported as the same conflict,
  // because an existing anchor proves another update already locked that revision number.
  async function retainFencedPlanSource({ planId, baseRevision, revision, canonicalBytes }) {
    const head = markdownPlanStore.list().find((entry) => entry.plan_id === planId);
    if (!head || head.revision !== baseRevision) throw decisionError("PLAN_REVISION_CONFLICT", `Plan ${planId} no longer has r${baseRevision} as its current revision; this update did not overwrite the accepted revision or its source snapshot.`);
    try { return await retainConversationPlanSource({ fileService, planId, revision, canonicalBytes }); }
    catch (error) {
      if (error.code !== "PLAN_SOURCE_MISMATCH") throw error;
      throw decisionError("PLAN_REVISION_CONFLICT", `Another update already locked r${revision} of plan ${planId}; its accepted revision and source snapshot stay unchanged.`);
    }
  }

  // Resumes an authenticated /plan-continue clarification and creates exactly one revision.
  async function continuePlan({ sessionId, conversationId, ownerId, expectedVersion, sourceSha256 }) {
    if (!ownerId) throw decisionError("PLAN_OWNER_UNAUTHORIZED", "Owner authentication is required to confirm planning choices.");
    return sessions.claim(sessionId, async (session, save) => {
      if (session.conversation_id !== conversationId || session.source_sha256 !== sourceSha256) throw decisionError("ARCHITECTURE_SESSION_STALE", "Clarification identity differs from the reviewed source or conversation.");
      if (session.status === "completed" && (!session.questions.length || session.owner_id === ownerId && session.confirmation_version === expectedVersion)) return session.result;
      if (session.status === "cancelled") throw decisionError("ARCHITECTURE_SESSION_STALE", "This planning request was cancelled.");
      const sourceText = await fileService.readFile({ path: session.source_path });
      if (!session.questions.length) return generate({ session, sourceText, planId: planIdFromIntakePath(session.source_path) ?? session.plan_id, save });
      if (session.confirmation_version === expectedVersion && session.owner_id === ownerId && ["generation_failed", "generating"].includes(session.status)) return generate({ session, sourceText, planId: planIdFromIntakePath(session.source_path) ?? session.plan_id, save });
      if (session.version !== expectedVersion || !["awaiting_owner_decisions", "generation_failed"].includes(session.status)) throw decisionError("ARCHITECTURE_SESSION_STALE", "Reload the latest choices before confirming.");
      const confirmed = await save({ selections: architectureSelections(session.questions, session.selections), owner_id: ownerId, confirmed_at: new Date().toISOString(), confirmation_version: session.version });
      return generate({ session: confirmed, sourceText, planId: planIdFromIntakePath(confirmed.source_path) ?? confirmed.plan_id, save });
    });
  }

  // Business purpose: generates and validates revision r1 with a bounded self-healing loop when Architecture Manager returns invalid JSON, violates schema, or references missing evidence paths.
  // Technical description: validates the candidate plan via parseArchitecturePlanJSON, renderArchitecturePlanMarkdown, and validateMarkdown; on recoverable schema/evidence failures, prompts AM to repair within maxRetries while preserving the Discovery Compact Receipt.
  async function requestValidatedGeneration({ session, effectiveSourceText, decisions, planId, retained, pregeneratedPlan }) {
    if (retained) {
      const baseMarkdown = renderArchitecturePlanMarkdown({ plan: retained, planId, revision: 1, sourceSha256: canonicalArchitecturePlanSha256(retained) });
      await validateMarkdown(baseMarkdown);
      return { plan: retained, baseMarkdown };
    }
    let discoveryReceipt = await loadDiscoveryReceiptBlock(session.conversation_id ?? "", session);
    let prompt = generationPrompt(effectiveSourceText, decisions, discoveryReceipt);
    let lastRaw = pregeneratedPlan ? canonicalizeArchitecturePlanJSON(pregeneratedPlan) : "";
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const plan = attempt === 0 && pregeneratedPlan
          ? pregeneratedPlan
          : parseArchitecturePlanJSON(lastRaw = String(await requestArchitecture(prompt, session.conversation_id ?? "", { responseContentType: "text/plain" }) ?? "").trim());
        await sessions.source(session);
        const baseMarkdown = renderArchitecturePlanMarkdown({ plan, planId, revision: 1, sourceSha256: canonicalArchitecturePlanSha256(plan) });
        await validateMarkdown(baseMarkdown);
        return { plan, baseMarkdown };
      } catch (error) {
        const recoverable = ["ARCHITECTURE_PLAN_JSON_INVALID", "ARCHITECTURE_PLAN_INVALID", "DISCOVERY_INCOMPLETE"].includes(error.code);
        if (!recoverable || attempt >= maxRetries) throw error;
        await sessions.source(session);
        discoveryReceipt = await loadDiscoveryReceiptBlock(session.conversation_id ?? "", session) || discoveryReceipt;
        prompt = generationRepairPrompt(effectiveSourceText, decisions, error, lastRaw, discoveryReceipt, attempt + 1, maxRetries);
      }
    }
    throw decisionError("PLAN_GENERATION_FAILED", "Architecture plan generation failed after self-healing retries.");
  }

  // Locks one revision: Node renders, appends authoritative decisions, then stores anchor-bound bytes.
  async function generate({ session, sourceText, planId, save, intake: suppliedIntake, pregeneratedPlan = null }) {
    let intake = suppliedIntake;
    if (!intake && typeof sourceText === "string" && sourceText.trim().startsWith("{")) {
      // eslint-disable-next-line no-silent-catch -- Non-JSON sourceText remains plain conversation text.
      try { intake = JSON.parse(sourceText); } catch { intake = null; }
    }
    const effectiveSourceText = typeof intake?.text === "string" ? intake.text : sourceText;
    try {
      const existing = markdownPlanStore.list().find((entry) => entry.plan_id === planId);
      if (existing) {
        const plan = await markdownPlanStore.getRevision({ planId, revision: existing.revision });
        const result = createdResult(plan, session, intake);
        await save({ status: "completed", result });
        return result;
      }
      await sessions.source(session);
      await save({ status: "generating", process_pid: process.pid, error_code: null });
      const decisions = (session.questions ?? []).map((question) => ({ question: question.title, reason: question.reason, selected: question.options.find((option) => option.id === (session.selections ?? {})[question.id]), owner_note: session.notes?.[question.id] ?? "" }));
      const retained = await readRetainedConversationPlanSource({ fileService, planId, revision: 1 });
      const { plan, baseMarkdown } = await requestValidatedGeneration({ session, effectiveSourceText, decisions, planId, retained, pregeneratedPlan });
      await sessions.source(session);
      const anchor = await retainConversationPlanSource({ fileService, planId, revision: 1, canonicalBytes: canonicalizeArchitecturePlanJSON(plan) });
      const stored = await markdownPlanStore.createRevision({ planId, expectedRevision: 0, markdown: appendArchitectureDecisions(baseMarkdown, session), summaryPath: anchor.path, summarySha256: anchor.sha256, conversationId: session.conversation_id ?? null });
      const result = createdResult(stored, session, intake);
      await save({ status: "completed", result });
      return result;
    } catch (error) {
      await save({ status: "generation_failed", error_code: error.code ?? "PLAN_GENERATION_FAILED" });
      throw error;
    }
  }

  // Saves explicit draft owner choices so an authenticated continuation can confirm them later.
  async function saveClarificationChoices({ sessionId, expectedVersion, sourceSha256, selections, notes = {} }) {
    return sessions.update(sessionId, { expectedVersion, sourceSha256, selections, notes });
  }

  return Object.freeze({ createFromConversation, updateFromConversation, continuePlan, saveClarificationChoices });
}

// Presents a clarification pause as a successful non-creation with no plan revision.
function waitingForOwner(session, intake) {
  const extra = intake && (intake.delivery_target !== "none" || intake.source_kind === "markdown_file" || intake.source_kind === "marked_ideas")
    ? { delivery_target: intake.delivery_target ?? "none", source_kind: intake.source_kind ?? "conversation", ...(intake.source_file_path ? { source_file_path: intake.source_file_path, source_file_sha256: intake.source_file_sha256 } : {}), ...(intake.idea_message_id ? { idea_message_id: intake.idea_message_id, idea_index: intake.idea_index } : {}) }
    : {};
  return { command: "/plan", status: "awaiting_owner_decisions", session_id: session.session_id, conversation_id: session.conversation_id, source_summary_path: session.source_path, source_summary_sha256: session.source_sha256, plan_id: planIdFromIntakePath(session.source_path), ...extra, text: `Architecture cần owner chốt ${session.questions.length} quyết định trước khi tạo plan. Chưa lưu revision.`, run_started: false, revision_created: false };
}

// Returns the authoritative identity, rendered Markdown and review status for one locked revision.
function createdResult(plan, session, intake) {
  const extra = intake && (intake.delivery_target !== "none" || intake.source_kind === "markdown_file" || intake.source_kind === "marked_ideas")
    ? { delivery_target: intake.delivery_target ?? "none", source_kind: intake.source_kind ?? "conversation", ...(intake.source_file_path ? { source_file_path: intake.source_file_path, source_file_sha256: intake.source_file_sha256 } : {}), ...(intake.idea_message_id ? { idea_message_id: intake.idea_message_id, idea_index: intake.idea_index } : {}) }
    : {};
  return { command: "/plan", status: plan.status ?? "awaiting_human_approval", session_id: session?.session_id ?? null, plan_id: plan.plan_id, revision: plan.revision, sha256: plan.sha256, file_id: plan.plan_id, path: plan.file_path, source_summary_path: plan.source_path, source_summary_sha256: plan.source_sha256, conversation_id: plan.conversation_id, markdown: plan.markdown, ...extra, text: `Đã tạo plan ${plan.plan_id} r${plan.revision}. Vào trang Coding để xem và approve plan. Chưa RUN.`, run_started: false, revision_created: true };
}

const PLAN_JSON_SHAPE = '{"title":"","objective":"","background":"","scope":["In scope: ...","Out of scope: ..."],"outcomes":[{"id":"O1","outcome":"","acceptance_criteria":[""],"guardrails":[""]}],"evidence":[{"path":"backend/src/example.js","location":"L1-L10","fact":""}],"assumptions":[""],"constraints":[""],"risks":[""],"verification":""}';

// Builds the owner-decision discovery instruction that keeps the existing prompt contract.
function clarificationPrompt(sourceText) {
  return `Architecture clarification discovery, not plan generation. Read the conversation and inspect the repository before deciding what actually needs owner authority. Respect decisions already stated: never ask them again. Ask only unresolved owner-level changes to system boundaries, business scope, security/data policy or explicit owner guardrails. Return ONLY JSON {"questions":[{"id":"STORAGE","title":"Question","reason":"Why the owner must decide","options":[{"id":"LOCAL","label":"Local storage","description":"Device-local persistence"},{"id":"SERVER","label":"Server storage","description":"Server persistence with access control"}],"recommended_option_id":"LOCAL"}]}, 2-10 alternatives each, or {"questions":[]} when none are needed. Do not draft a plan, persist files, claim approval or dispatch work.\n\nOwner conversation:\n${sourceText}\n\n--- End of Owner Conversation ---\nIMPORTANT: This step is Phase 1 (Clarification Discovery ONLY). Return ONLY valid JSON {"questions":[]} (when no owner-level policy decisions are needed) or {"questions":[...]} with no surrounding prose.`;
}

// Builds the strict full-plan JSON instruction so only AM supplies plan content.
function generationPrompt(sourceText, decisions, discoveryReceipt = "") {
  return `Architecture plan generation. Call lookup_schema({"schema_id":"architecture_manager.architecture_plan.v1"}) (or lookup_schema({"task":"architecture_plan"})) to inspect the contract, complete repository discovery, then return ONLY one JSON object matching this shape: ${PLAN_JSON_SHAPE}. Include all 10 required fields with no extra keys and no null values; scope, outcomes, evidence, assumptions, outcomes[].acceptance_criteria and outcomes[].guardrails must each contain at least 1 non-empty string (record prerequisite outcome IDs like "O1" as separate items in guardrails; constraints and risks allow 0..40 items). Do not return Markdown, prose, comments, approval claims, file writes or RUN claims. Every repository fact needs an evidence entry with a real path under backend/, schemas/, ui/, web/, docs/ or workflows/, and assumptions stay explicit. Evidence location is optional; when present use positive source lines such as L17-L75 or L17-L75; L98-L106, never descriptive prose. Apply ALL confirmed owner policies consistently and never re-ask them. Node alone validates, locks the revision and appends the authoritative owner decision record.${decisions?.length ? `\n\nConfirmed owner decisions:\n${JSON.stringify(decisions)}` : ""}${discoveryReceipt || ""}\n\nOwner conversation:\n${sourceText}\n\n--- End of Owner Conversation ---\nIMPORTANT: Return ONLY one valid JSON object matching architecture_manager.architecture_plan.v1 with no surrounding prose.`;
}

// Builds the RFC 7396 merge-patch instruction against the retained canonical base.
function updatePrompt(sourceText, baseJson, discoveryReceipt = "") {
  return `Architecture plan update. Call lookup_schema({"schema_id":"architecture_manager.architecture_plan.v1"}) if needed to verify the target contract, then return ONLY one JSON RFC 7396 merge patch against the canonical plan below: changed fields carry new values, modified arrays replace the whole array, removed nested fields use null, untouched fields are omitted, no unknown root fields are allowed, and no root required field may be null. Do not return Markdown, prose, approval claims, file writes or RUN claims. Node alone merges, revalidates the full schema, and locks the next revision.${discoveryReceipt || ""}\n\nCanonical plan:\n${baseJson}\n\nOwner conversation:\n${sourceText}`;
}

/**
 * Business purpose: builds the self-healing prompt when Architecture Manager's Phase 1 clarification response fails JSON parsing or question schema validation.
 * Technical description: appends the error code, diagnostic message, previous draft, and preserved Discovery Compact Receipt to the base clarification prompt.
 */
function clarificationRepairPrompt(sourceText, error, previousDraft, discoveryReceipt = "", attempt = 1, maxRetries = 2) {
  return `${clarificationPrompt(sourceText)}${discoveryReceipt || ""}\n\n[SELF-HEALING CLARIFICATION RETRY ${attempt}/${maxRetries} — ERROR ${error?.code ?? "ARCHITECTURE_QUESTIONS_INVALID"}]: Your previous response failed validation: ${error?.message ?? "Invalid JSON question response"}. Return ONLY valid JSON {"questions":[]} or {"questions":[...]} with no surrounding prose.\n\nPrevious invalid draft:\n${previousDraft}`;
}

/**
 * Business purpose: builds the self-healing prompt when Architecture Manager's Phase 2 plan generation response fails JSON parsing, schema validation, or repository evidence checks.
 * Technical description: combines the base generationPrompt with the preserved Discovery Compact Receipt, exact error code/message, missing evidence diagnostics, and the previous draft so AM can repair without re-reading verified files.
 */
function generationRepairPrompt(sourceText, decisions, error, previousDraft, discoveryReceipt = "", attempt = 1, maxRetries = 2) {
  const missingInfo = Array.isArray(error?.missing_evidence_paths) && error.missing_evidence_paths.length ? ` Missing or unreadable evidence path(s): ${error.missing_evidence_paths.join(", ")}.` : "";
  return `${generationPrompt(sourceText, decisions, discoveryReceipt)}\n\n[SELF-HEALING PLAN GENERATION RETRY ${attempt}/${maxRetries} — ERROR ${error?.code ?? "ARCHITECTURE_PLAN_JSON_INVALID"}]: Your previous draft failed validation: ${error?.message ?? "Invalid plan JSON"}.${missingInfo} Fix all schema or evidence errors (use read-only discovery tools if you need to verify real repository paths) and return ONLY one valid JSON object matching architecture_manager.architecture_plan.v1.\n\nPrevious draft:\n${previousDraft}`;
}

/**
 * Business purpose: builds the self-healing prompt when Architecture Manager's Phase 3 RFC 7396 merge patch fails JSON parsing, schema revalidation, or evidence checks.
 * Technical description: combines the base updatePrompt with the preserved Discovery Compact Receipt, error code/message, and previous patch draft so AM emits a valid RFC 7396 JSON merge patch.
 */
function updateRepairPrompt(sourceText, baseJson, error, previousDraft, discoveryReceipt = "", attempt = 1, maxRetries = 2) {
  return `${updatePrompt(sourceText, baseJson, discoveryReceipt)}\n\n[SELF-HEALING PLAN UPDATE RETRY ${attempt}/${maxRetries} — ERROR ${error?.code ?? "ARCHITECTURE_PLAN_PATCH_INVALID"}]: Your previous merge patch failed validation: ${error?.message ?? "Invalid RFC 7396 merge patch"}. Return ONLY one valid RFC 7396 JSON merge patch object against the canonical plan with no surrounding prose.\n\nPrevious invalid patch draft:\n${previousDraft}`;
}
