import { ConfigurationError } from "../../shared/errors.js";
import { createStage1TaskRequestBuilder } from "../workflows/stage1-task-request-builder.js";
import { buildStage1InstructionBlocks, CODE_REQUIRE_INSTRUCTION, STRUCTURED_PATCH_CONTRACT } from "../workflows/stage1-instructions.js";

// Round that produced the first code submission. Repair rounds (R4, R5, ...)
// always point back at it, so its transcript block stays expandable.
const ORIGIN_CODE_ROUND = 3;

export function createSupervisorRoundController({ contextProvider, fullContextProvider = contextProvider, persistPlan = async () => {}, conversationStateStore, conversationId, protocolStorage, requestBuilder = createStage1TaskRequestBuilder(), agentResolver, projectLogger = () => {}, executionContextProvider } = {}) {
  let round = 0;
  let approvedPlan = null;
  const defaultAgentId = () => agentResolver?.resolve?.("coder") ?? "builder";
  let context = [];
  const transcript = [];
  const transcriptBlocks = [];
  let taskSource = null;
  const RESPONSE_TYPE_ALIASES = Object.freeze({
    request_info: "code_needed",
    submit_code: "submit_code_response"
  });
  return Object.freeze({ start, onResponse, requestRepair, getRound: () => round, getPlan: () => approvedPlan, getTranscriptBlocks: () => transcriptBlocks.map((block) => ({ ...block })) });

  async function start(request = {}) {
    taskSource = structuredClone(request);
    round = 1;
    if (conversationStateStore?.create && conversationId) await conversationStateStore.create({ conversationId, taskId: request.task_id, projectId: request.project_id, agentId: request.agent_id ?? defaultAgentId() });
    return requestForRound(request, "task", "code_needed");
  }

  async function onResponse({ event, response } = {}) {
    if (!response || typeof response !== "object") throw new ConfigurationError("Supervisor received an invalid Agent response.");
    response = normalizeAgentResponse(response);
    // A recovered Supervisor resumes from its persisted request without calling
    // start(); restore the initial round before routing the first response.
    if (round === 0) round = 1;
    const tool = response.tool_use ?? response.payload?.tool_use;
    if (tool?.name && tool.input && typeof tool.input === "object") response = { ...tool.input, type: tool.name, payload: tool.input, response_id: response.response_id ?? response.payload?.response_id };
    if (round === 1) {
      transcript.push({ type: "response", round, response });
      appendTranscriptBlock(event, round, "task", response);
      if (response.type !== "code_needed") throw new ConfigurationError(`R1 expected code_needed, received ${response.type ?? "<missing>"}.`);
      if (typeof contextProvider !== "function") throw new ConfigurationError("R1 requires a context provider for R2.");
      context = await contextProvider({ event, response, phase: "summary" });
      round = 2;
      return { request: await requestForRound({ ...event, context }, "planning", "planning", { context }) };
    }
    if (round === 2) {
      transcript.push({ type: "response", round, response });
      // R2 can loop: a code_needed response re-requests round 2 without
      // advancing. Tag it so the repeat is indexed instead of being dropped.
      appendTranscriptBlock(event, round, "planning", response, { roundKind: response.type === "planning" ? "initial" : "planning_retry" });
      if (response.type === "code_needed") {
        if (typeof contextProvider !== "function") throw new ConfigurationError("R2 code_needed requires a context provider.");
        context = await contextProvider({ event, response, phase: "summary" });
        return { request: await requestForRound({ ...event, context }, "planning", "planning", { context }) };
      }
      if (response.type !== "planning") throw new ConfigurationError(`R2 expected planning, received ${response.type ?? "<missing>"}.`);
      if (!Array.isArray(response.plan) && !Array.isArray(response.payload?.plan)) throw new ConfigurationError("R2 planning response requires plan[].");
      approvedPlan = response.plan ?? response.payload.plan;
      validatePlan(approvedPlan);
      await persistPlan(approvedPlan, { event, context });
      round = 3;
      // R3 needs full source for both files being changed and files marked
      // READ_ONLY; NEW files remain context placeholders because they do not exist yet.
      const implementationPlan = approvedPlan.filter((item) =>
        (item?.action === "NEW" || item?.action === "MODIFY" || item?.action === "READ_ONLY") && isFilePath(item?.path)
      );
      const fullContext = typeof fullContextProvider === "function"
        ? await fullContextProvider({ event, response: { ...response, plan: approvedPlan, files_requested: implementationPlan.map((item) => item.path) }, context, phase: "full" })
        : typeof contextProvider === "function"
          ? await contextProvider({ event, response: { ...response, plan: approvedPlan, files_requested: implementationPlan.map((item) => item.path) }, context, phase: "full" })
          : context;
      assertFullContext(fullContext, implementationPlan);
      context = fullContext;
      return { request: await requestForRound({ ...event, context: fullContext, plan: approvedPlan }, "code_provide", "submit_code_response", { context: fullContext, plan: approvedPlan }) };
    }
    if (round >= 3) {
      if (response.type !== "submit_code_response") throw new ConfigurationError(`R${round} expected submit_code_response, received ${response.type ?? "<missing>"}.`);
      appendTranscriptBlock(event, round, "code_provide", response, { roundKind: round > 3 ? "repair" : "initial", repairRound: round > 3 ? round - 3 : null });
      // Materialize the response that was actually returned. Missing approved files
      // are reported by materialization rather than causing a second R3 request.
      return { materialize: true, approved_plan: approvedPlan };
    }
    throw new ConfigurationError(`Unsupported Supervisor round: ${round}.`);
  }

  async function requestRepair(source = {}, reason = "materialization") {
    const payload = source.payload ?? source;
    const failed = payload.invalid_patches ?? Object.values(payload.invalid ?? {});
    const files = failed.filter((file) => file?.path && file.format !== "none").map((file) => ({ path: file.path, format: file.format === "full_content" ? "full_content" : "structured_patch", content: file.current_content ?? file.submitted_content ?? null, current_content: file.current_content ?? null, exists: file.format !== "full_content", before_checksum: file.before_checksum ?? null, language: file.language ?? "text", size_bytes: file.size_bytes ?? 0 }));
    const nextRound = Math.max(ORIGIN_CODE_ROUND + 1, round + 1);
    round = nextRound;
    const plan = approvedPlan ?? payload.approved_plan ?? [];
    const correction = reason === "materialization"
      ? "Repair the rejected operations using the complete current source provided for each file. Return every failed approved file."
      : "Repair the verification failures using the complete current source provided for each file. Return every failed approved file.";
    return requestForRound({ ...source, ...payload, task_id: source.task_id ?? payload.task_id, request_id: source.request_id, parent_id: source.request_id, context: files, plan }, "code_provide", "submit_code_response", { round: nextRound, context: files, plan, repair: { reason, failed, correction } });
  }

  function canonicalResponseType(type) {
    return typeof type === "string" ? (RESPONSE_TYPE_ALIASES[type] ?? type) : type;
  }

  function normalizeToolResponse(tool, source = {}) {
    const input = tool?.input;
    if (!tool?.name || !input || typeof input !== "object") return null;
    const type = canonicalResponseType(tool.name === "agent_tool" ? (input.type ?? input.kind) : tool.name);
    return {
      ...input,
      type,
      payload: input.payload ?? input,
      response_id: source.response_id ?? source.payload?.response_id
    };
  }

  function normalizeAgentResponse(value) {
    const unwrapped = unwrapAgentResponse(value);
    if (unwrapped?.status === "failed" || unwrapped?.raw_response?.status === "failed") {
      const error = new ConfigurationError("Provider returned a failed response before producing an Agent response.");
      error.code = "PROVIDER_RESPONSE_FAILED";
      error.providerStatus = "failed";
      error.providerDetail = unwrapped.error ?? unwrapped.raw_response?.error ?? null;
      throw error;
    }
    const toolResponse = normalizeToolResponse(unwrapped?.tool_use ?? unwrapped?.payload?.tool_use, unwrapped);
    if (toolResponse) return toolResponse;
    if (unwrapped?.type) return { ...unwrapped, type: canonicalResponseType(unwrapped.type) };
    const payload = unwrapped?.payload;
    if (payload?.type) return { ...payload, type: canonicalResponseType(payload.type), payload: payload.payload ?? payload };
    if (payload?.kind) return { ...payload, type: canonicalResponseType(payload.kind), payload: payload.payload ?? payload };
    const text = typeof unwrapped?.text === "string"
      ? unwrapped.text
      : typeof payload?.text === "string"
        ? payload.text
        : null;
    if (text?.trim()) {
      try {
        return normalizeAgentResponse(JSON.parse(text));
      } catch {}
    }
    return unwrapped;
  }

  function unwrapAgentResponse(value) {
    let current = value;
    for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
      if (typeof current.type === "string") return current;
      const tool = current.tool_use ?? current.payload?.tool_use;
      if (tool?.name && tool.input && typeof tool.input === "object") return { ...tool.input, type: tool.name, payload: tool.input, response_id: current.response_id ?? current.payload?.response_id };
      const nested = current.response ?? current.payload?.response ?? current.result ?? current.payload;
      if (!nested || nested === current || typeof nested !== "object") break;
      current = nested;
    }
    return current;
  }

  // Blocks are append-only and immutable once closed: the OpenAI transcript
  // resolver expands them by ref and prompt caching keys off a stable prefix,
  // so in_window is decided here once and never recalculated later.
  function appendTranscriptBlock(event, roundNumber, instruction, response, { roundKind = "initial", outcome = null, repairRound = null } = {}) {
    const taskId = event?.task_id ?? event?.payload?.task_id;
    if (typeof taskId !== "string" || !taskId) return;
    const requestId = requestIdForRound(event, roundNumber);
    const repeats = transcriptBlocks.filter((block) => block.round === roundNumber).length;
    // Dedup by request_id, not round: a repeated round 2 is a distinct exchange
    // and dropping it would leave the first response's summary standing in for both.
    if (requestId ? transcriptBlocks.some((block) => block.request_id === requestId) : repeats > 0) return;
    transcriptBlocks.push({
      block_id: repeats ? `round-${roundNumber}.${repeats + 1}` : `round-${roundNumber}`,
      round: roundNumber,
      request_id: requestId,
      response_id: responseIdOf(response),
      round_kind: roundKind,
      repair_round: Number.isInteger(repairRound) ? repairRound : null,
      instruction,
      response_summary: summarizeRound(response, outcome),
      outcome: outcome && typeof outcome === "object" ? structuredClone(outcome) : null,
      full_request_ref: `task/${taskId}/round_${roundNumber}/request`,
      full_response_ref: `task/${taskId}/round_${roundNumber}/response`,
      in_window: inWindowFor(roundNumber, roundKind),
      closed_at: new Date().toISOString(),
      cacheable: false
    });
  }

  function requestIdForRound(event, roundNumber) {
    if (typeof event?.request_id === "string" && event.request_id) return event.request_id;
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      const entry = transcript[index];
      if (entry?.type === "request" && entry.round === roundNumber && typeof entry.request_id === "string") return entry.request_id;
    }
    return null;
  }

  function responseIdOf(response) {
    const value = response?.response_id ?? response?.payload?.response_id ?? response?.provider_metadata?.response_id;
    return typeof value === "string" && value ? value : null;
  }

  // Round 1 (task statement), round 2 (approved plan) and the origin code round
  // stay expandable. Intermediate repair rounds collapse to their summary: the
  // next repair request already pushes invalid/failed_operations for them.
  function inWindowFor(roundNumber, roundKind) {
    if (roundKind === "repair") return false;
    // A repeated round 2 is persisted at task/{id}/round_2/{request,response}
    // with replace:true, so the refs of every R2 exchange point at whichever one
    // was saved last. Expanding this block would resolve the wrong payload, and
    // its summary is accurate — collapse to the summary instead.
    if (roundKind === "planning_retry") return false;
    return roundNumber === 1 || roundNumber === 2 || roundNumber === ORIGIN_CODE_ROUND;
  }

  // An out-of-window round is reduced to this single line by the transcript
  // resolver, so the summary has to carry what actually happened in the round.
  function summarizeRound(response, outcome) {
    if (outcome && typeof outcome === "object") {
      const codes = Array.isArray(outcome.codes) && outcome.codes.length ? `: ${outcome.codes.join(", ")}` : "";
      return `valid ${outcome.valid_count ?? 0}, invalid ${outcome.invalid_count ?? 0}${codes}`;
    }
    const type = String(response?.type ?? response?.payload?.type ?? "response");
    if (type === "code_needed") return `code_needed: requested ${listCount(response, "files_requested")} file(s)`;
    if (type === "planning") return `planning: approved ${planSummary(response?.plan ?? response?.payload?.plan)}`;
    if (type === "submit_code_response") return `submit_code_response: submitted ${listCount(response, "files")} file(s)`;
    return type;
  }

  function listCount(response, field) {
    const value = response?.[field] ?? response?.payload?.[field];
    return Array.isArray(value) ? value.length : 0;
  }

  function planSummary(plan) {
    if (!Array.isArray(plan) || !plan.length) return "empty plan";
    const counts = new Map();
    for (const item of plan) {
      const action = typeof item?.action === "string" ? item.action : "UNKNOWN";
      counts.set(action, (counts.get(action) ?? 0) + 1);
    }
    return `${plan.length} file(s): ${[...counts].map(([action, count]) => `${count} ${action}`).join(", ")}`;
  }

  function assertFullContext(files, plan) {
    const byPath = new Map((Array.isArray(files) ? files : []).map((file) => [file.path, file]));
    for (const item of plan) {
      if (item.action !== "MODIFY") continue;
      const file = byPath.get(item.path);
      if (!file || file.exists !== true || typeof file.content !== "string") {
        throw new ConfigurationError(`R3 requires full file content for MODIFY path: ${item.path}.`);
      }
    }
  }

  function validatePlan(plan) {
    const seen = new Map();
    for (const item of plan) {
      if (!item || typeof item !== "object" || !isFilePath(item.path) || !["NEW", "MODIFY", "READ_ONLY"].includes(item.action)) {
        const error = new ConfigurationError("PLAN_INVALID: each plan item requires a concrete path and one action: NEW, MODIFY, or READ_ONLY.");
        error.code = "PLAN_INVALID";
        throw error;
      }
      if (seen.has(item.path)) {
        const error = new ConfigurationError(`PLAN_DUPLICATE_PATH: ${item.path} appears more than once (${seen.get(item.path)} and ${item.action}).`);
        error.code = "PLAN_DUPLICATE_PATH";
        throw error;
      }
      seen.set(item.path, item.action);
    }
  }

  function isFilePath(value) {
    return typeof value === "string" && value.length > 0 && !value.endsWith("/") && !value.split("/").some((segment) => segment === "." || segment === "..");
  }

  function isUuid(value) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  async function requestForRound(source, type, expectedType, extra = {}) {
    const origin = { ...(taskSource ?? {}), ...(source ?? {}) };
    const roundNumber = Number.isInteger(extra.round) ? extra.round : type === "task" ? 1 : type === "planning" ? 2 : 3;
    const ticket = origin.ticket ?? origin.payload?.task ?? {
      id: origin.task_id, project_id: origin.project_id ?? "PROJECT", title: source.payload?.text ?? origin.task_id,
      objective: source.payload?.text ?? origin.task_id, acceptance_criteria: source.payload?.acceptance_criteria ?? [source.payload?.text ?? origin.task_id]
    };
    const built = requestBuilder.buildTaskRequest(ticket, {
      agentId: origin.agent_id ?? "builder", conversationId, correlationId: origin.correlation_id,
      stepId: roundNumber, parentId: isUuid(origin.parent_id) ? origin.parent_id : null,
      relevantTree: origin.relevantTree ?? [], submissionFormat: origin.submissionFormat
    });
    const executionContext = typeof executionContextProvider === "function"
      ? await executionContextProvider({ source: origin, round: roundNumber, type, context: extra.context ?? context })
      : origin.execution_context ?? origin.executionContext ?? null;
    const envelope = {
      ...built,
      task_id: origin.task_id,
      supervisor_id: source.supervisor_id,
      request_id: built.request_id,
      parent_id: roundNumber > 1
        ? (isUuid(origin.request_id) ? origin.request_id : (isUuid(origin.parent_id) ? origin.parent_id : built.parent_id))
        : (isUuid(origin.parent_id) ? origin.parent_id : built.parent_id),
      correlation_id: origin.correlation_id,
      attempt: origin.attempt ?? 1,
      agent_id: origin.agent_id ?? "builder",
      type,
      payload: {
        ...built.payload,
        type,
        task_id: origin.task_id,
        step_id: roundNumber,
        expected_output: { type: expectedType, transport: "function_tool" },
        ...(executionContext ? { execution_context: structuredClone(executionContext) } : {}),
        transcript_blocks: transcriptBlocks.map((block) => ({ ...block })),
        user_blocks: type === "planning"
          ? [
            ...built.payload.user_blocks.filter((block) => block.block_id !== "code_graph_candidates"),
            ...(extra.context?.length ? [{ block_id: "planning-context", content: JSON.stringify({ files: extra.context }), cacheable: false }] : [])
          ]
          : extra.repair
            ? [{ block_id: "repair-context", content: JSON.stringify({ files: extra.context, errors: extra.repair.failed }), cacheable: false }]
            : [...built.payload.user_blocks],
        instruction_blocks: type === "task"
          ? buildStage1InstructionBlocks({ includeTaskReview: true, includeConventions: true, includeCodeGraphCandidates: true })
          : type === "planning"
            ? buildStage1InstructionBlocks({ includePlanning: true, includeConventions: false })
            : [
              { block_id: "code_require", content: CODE_REQUIRE_INSTRUCTION, cacheable: false },
              { block_id: "structured-patch-contract", content: STRUCTURED_PATCH_CONTRACT, cacheable: true },
              ...(extra.repair ? [{ block_id: "repair-correction", content: extra.repair.correction, cacheable: false }] : [])
            ],
        ...(type === "planning" && extra.context ? { files: extra.context } : {}),
        ...(type === "code_provide" && extra.repair ? { files: extra.context } : {}),
        ...(type === "code_provide" && extra.plan ? { plan: extra.plan.map((item) => { const file = extra.context?.find((entry) => entry.path === item.path); const repair = Boolean(extra.repair); return { ...item, before_checksum: item.action === "NEW" ? null : (file?.before_checksum ?? null), content: repair && item.action === "MODIFY" ? (file?.content ?? null) : null, exists: item.action !== "NEW", language: file?.language ?? "text", size_bytes: item.action === "NEW" ? 0 : (file?.size_bytes ?? 0), format: item.action === "NEW" ? "full_content" : item.action === "MODIFY" ? "structured_patch" : "none" }; }) } : {})
      }
    };
    transcript.push({ type: "request", round: roundNumber, request_id: envelope.request_id, payload: envelope.payload });
    if (conversationStateStore?.advanceRound && conversationId) {
      const currentState = await conversationStateStore.get?.(conversationId);
      if (!currentState || !Number.isInteger(currentState.current_round) || currentState.current_round < roundNumber) {
        await conversationStateStore.advanceRound(conversationId, { round: roundNumber, step: roundNumber, requestId: envelope.request_id, parentId: envelope.parent_id, status: type === "task" ? "round_1_sent" : type === "planning" ? "round_2_sent" : "round_3_sent" });
      }
    }
    if (protocolStorage?.save) await protocolStorage.save(`task/${origin.task_id}/round_${roundNumber}/request`, envelope, { replace: true, schemaId: "https://forge.local/schemas/agent/envelope.schema.json" });
    projectLogger({ event_name: "supervisor.request_persisted", level: "info", status: "success", message: "Supervisor persisted round request before dispatch.", task_id: origin.task_id, correlation_id: origin.correlation_id, source: "round-controller", payload: { request_id: envelope.request_id, round: roundNumber, type } });
    return envelope;
  }

}
