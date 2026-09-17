// Summary: Builds cache-friendly attempt envelopes with tiered memory/context blocks and repair-round failure injection.
import { createStage1TaskRequestBuilder } from "../workflows/stage1-task-request-builder.js";
import { buildStage1InstructionBlocks } from "../workflows/stage1-instructions.js";
import { ConfigurationError } from "../../shared/errors.js";

// Builds the request envelope for each supervised attempt. Attempt 1 carries
// ticket + context pack + project memory facts; attempts 2+ reuse the same
// tiers 1+2 byte-for-byte (prefix cache) and append failure context LAST so the
// correction never invalidates the cached prefix.
/** Creates a builder that assembles attempt envelopes with cached tiers and repair failure injection. */
export function createAttemptContextBuilder({ protocolStorage, requestBuilder = createStage1TaskRequestBuilder(), projectLogger = () => {}, executionContextProvider, memoryRetriever, relevantTreeSelector } = {}) {
  let attempt = 0;
  let attemptOneEnvelope = null;
  const transcriptBlocks = [];
  return Object.freeze({ buildAttemptRequest, buildRepairRequest, onResponse, getAttempt: () => attempt, getTranscriptBlocks: () => transcriptBlocks.map((block) => ({ ...block })) });

  async function onResponse({ event, response } = {}) {
    if (!response || typeof response !== "object") throw new ConfigurationError("Supervisor received an invalid Agent response.");
    if (attempt === 0) attempt = 1;
    const taskId = event?.task_id ?? event?.payload?.task_id;
    if (typeof taskId !== "string" || !taskId) return;
    const requestId = typeof event?.request_id === "string" ? event.request_id : null;
    if (requestId && transcriptBlocks.some((block) => block.request_id === requestId)) return;
    transcriptBlocks.push({
      block_id: `attempt-${attempt}`,
      attempt,
      round: attempt,
      request_id: requestId,
      response_id: responseIdOf(response),
      round_kind: attempt === 1 ? "initial" : "repair",
      repair_round: attempt > 1 ? attempt - 1 : null,
      instruction: "session",
      response_summary: summarizeResponse(response),
      full_request_ref: `task/${taskId}/attempt_${attempt}/request`,
      full_response_ref: `task/${taskId}/attempt_${attempt}/response`,
      in_window: false,
      closed_at: new Date().toISOString(),
      cacheable: false
    });
  }

  async function buildAttemptRequest(request = {}) {
    attempt = 1;
    const origin = { ...request };
    const envelope = await buildEnvelope(origin, { kind: "attempt" });
    attemptOneEnvelope = envelope;
    return envelope;
  }

  async function buildRepairRequest(source = {}, { reason = "verification", failures = [], gitDiff = null } = {}) {
    if (!attemptOneEnvelope) throw new ConfigurationError("Repair attempt requires a persisted attempt 1 request.");
    attempt += 1;
    const failureBlock = {
      block_id: `repair-context-attempt-${attempt}`,
      content: JSON.stringify({ reason, failures, git_diff: gitDiff }),
      cacheable: false
    };
    const envelope = structuredClone(attemptOneEnvelope);
    envelope.request_id = crypto.randomUUID();
    envelope.parent_id = attemptOneEnvelope.request_id;
    envelope.attempt = source.attempt ?? attempt;
    envelope.payload = {
      ...envelope.payload,
      step_id: attempt,
      transcript_blocks: transcriptBlocks.map((block) => ({ ...block })),
      user_blocks: [...(attemptOneEnvelope.payload?.user_blocks ?? []), failureBlock],
      metadata: { ...(attemptOneEnvelope.payload?.metadata ?? {}), retry_of_step: attemptOneEnvelope.payload?.step_id ?? 1, previous_error: summarizeFailures(failures) }
    };
    if (typeof executionContextProvider === "function") {
      envelope.payload.execution_context = await executionContextProvider({ source: { ...source, agent_id: envelope.agent_id }, round: attempt, type: "repair" });
    }
    if (protocolStorage?.save) await protocolStorage.save(`task/${source.task_id ?? envelope.task_id}/round_${attempt}/request`, envelope, { replace: true, schemaId: "https://forge.local/schemas/agent/envelope.schema.json" });
    projectLogger({ event_name: "supervisor.request_persisted", level: "info", status: "success", message: "Supervisor persisted repair attempt request before dispatch.", task_id: source.task_id ?? envelope.task_id, correlation_id: source.correlation_id, source: "attempt-context-builder", payload: { request_id: envelope.request_id, attempt, kind: "repair" } });
    return envelope;
  }

  async function buildEnvelope(origin, { kind } = {}) {
    const ticket = origin.ticket ?? origin.payload?.ticket ?? origin.payload?.task ?? {
      id: origin.task_id,
      project_id: origin.project_id ?? "PROJECT",
      title: origin.payload?.text ?? origin.task_id,
      objective: origin.payload?.text ?? origin.task_id,
      acceptance_criteria: origin.payload?.acceptance_criteria ?? [origin.payload?.text ?? origin.task_id]
    };
    const attemptNumber = attempt;
    const memoryFacts = typeof memoryRetriever?.retrieve === "function"
      ? await memoryRetriever.retrieve({ projectId: ticket.project_id, taskId: ticket.id, query: `${ticket.title} ${ticket.objective}` }).then((result) => result?.relevant_facts ?? []).catch(() => [])
      : [];
    const relevantTree = origin.relevantTree ?? (typeof relevantTreeSelector?.select === "function" ? await relevantTreeSelector.select({ title: ticket.title, objective: ticket.objective, acceptanceCriteria: ticket.acceptance_criteria ?? [] }).then((result) => result?.tree ?? []).catch(() => []) : []);
    const built = requestBuilder.buildTaskRequest(ticket, {
      agentId: origin.agent_id ?? "builder",
      conversationId: `CONV-BUILDER-${ticket.project_id ?? "PROJECT"}-${ticket.id}`,
      correlationId: origin.correlation_id,
      stepId: attemptNumber,
      parentId: null,
      relevantTree
    });
    const executionContext = typeof executionContextProvider === "function"
      ? await executionContextProvider({ source: origin, round: attemptNumber, type: "task" })
      : origin.execution_context ?? null;
    const envelope = {
      ...built,
      task_id: origin.task_id ?? ticket.id,
      supervisor_id: origin.supervisor_id,
      correlation_id: origin.correlation_id,
      attempt: origin.attempt ?? attemptNumber,
      agent_id: origin.agent_id ?? "builder",
      type: "task",
      payload: {
        ...built.payload,
        type: "task",
        task_id: origin.task_id ?? ticket.id,
        step_id: attemptNumber,
        ...(executionContext ? { execution_context: structuredClone(executionContext) } : {}),
        transcript_blocks: [],
        // Tier 1: stable across tickets (project memory). Tier 2: ticket +
        // context pack, byte-identical within an attempt (repair clones it).
        // Tier 3 (tool results, repair correction) is always appended last.
        user_blocks: [
          ...(memoryFacts.length ? [{ block_id: "project-memory", content: JSON.stringify({ facts: memoryFacts }), cacheable: true }] : []),
          ...built.payload.user_blocks.map((block) => ({ ...block, cacheable: true })),
          ...(relevantTree.length ? [{ block_id: "context-pack", content: JSON.stringify({ relevant_tree: relevantTree }), cacheable: true }] : [])
        ],
        instruction_blocks: buildStage1InstructionBlocks({ includeTaskReview: true, includeConventions: true, includeCodeGraphCandidates: true })
      }
    };
    if (relevantTree.length) envelope.payload.relevant_tree = relevantTree;
    if (protocolStorage?.save) await protocolStorage.save(`task/${envelope.task_id}/round_${attemptNumber}/request`, envelope, { replace: true, schemaId: "https://forge.local/schemas/agent/envelope.schema.json" });
    projectLogger({ event_name: "supervisor.request_persisted", level: "info", status: "success", message: "Supervisor persisted attempt request before dispatch.", task_id: envelope.task_id, correlation_id: origin.correlation_id, source: "attempt-context-builder", payload: { request_id: envelope.request_id, attempt: attemptNumber, kind } });
    return envelope;
  }
}

function responseIdOf(response) {
  const value = response?.response_id ?? response?.payload?.response_id ?? response?.provider_metadata?.response_id;
  return typeof value === "string" && value ? value : null;
}

function summarizeResponse(response) {
  const type = String(response?.type ?? response?.payload?.type ?? "session");
  return `${type}: session ended`;
}

function summarizeFailures(failures) {
  if (!Array.isArray(failures) || !failures.length) return null;
  return failures.map((failure) => typeof failure === "string" ? failure : failure?.message ?? failure?.code ?? JSON.stringify(failure)).join("; ").slice(0, 500);
}
