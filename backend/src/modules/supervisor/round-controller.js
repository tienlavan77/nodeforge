import { ConfigurationError } from "../../shared/errors.js";
import { createStage1TaskRequestBuilder } from "../workflows/stage1-task-request-builder.js";
import { buildStage1InstructionBlocks, CODE_REQUIRE_INSTRUCTION, STRUCTURED_PATCH_CONTRACT } from "../workflows/stage1-instructions.js";

export function createSupervisorRoundController({ contextProvider, fullContextProvider = contextProvider, persistPlan = async () => {}, conversationStateStore, conversationId, protocolStorage, requestBuilder = createStage1TaskRequestBuilder() } = {}) {
  let round = 0;
  let approvedPlan = null;
  let context = [];
  const transcript = [];
  const transcriptBlocks = [];
  let taskSource = null;
  return Object.freeze({ start, onResponse, getRound: () => round, getPlan: () => approvedPlan });

  async function start(request = {}) {
    taskSource = structuredClone(request);
    round = 1;
    if (conversationStateStore?.create && conversationId) await conversationStateStore.create({ conversationId, taskId: request.task_id, projectId: request.project_id, agentId: request.agent_id ?? "builder" });
    return requestForRound(request, "task", "code_needed");
  }

  async function onResponse({ event, response } = {}) {
    if (!response || typeof response !== "object") throw new ConfigurationError("Supervisor received an invalid Agent response.");
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
      appendTranscriptBlock(event, round, "planning", response);
      if (response.type !== "planning") throw new ConfigurationError(`R2 expected planning, received ${response.type ?? "<missing>"}.`);
      if (!Array.isArray(response.plan) && !Array.isArray(response.payload?.plan)) throw new ConfigurationError("R2 planning response requires plan[].");
      approvedPlan = response.plan ?? response.payload.plan;
      await persistPlan(approvedPlan, { event, context });
      round = 3;
      const fullContext = typeof fullContextProvider === "function" ? await fullContextProvider({ event, response: { ...response, files_requested: approvedPlan.map((item) => item.path) }, context, phase: "full" }) : context;
      return { request: await requestForRound({ ...event, context: fullContext, plan: approvedPlan }, "code_provide", "submit_code_response", { context, plan: approvedPlan }) };
    }
    if (round === 3) {
      if (response.type !== "submit_code_response") throw new ConfigurationError(`R3 expected submit_code_response, received ${response.type ?? "<missing>"}.`);
      return { materialize: true };
    }
    throw new ConfigurationError(`Unsupported Supervisor round: ${round}.`);
  }

  function appendTranscriptBlock(event, roundNumber, instruction, response) {
    if (transcriptBlocks.some((block) => block.round === roundNumber)) return;
    const taskId = event?.task_id ?? event?.payload?.task_id;
    if (typeof taskId !== "string" || !taskId) return;
    transcriptBlocks.push({
      block_id: `round-${roundNumber}`,
      round: roundNumber,
      instruction,
      response_summary: String(response?.type ?? response?.payload?.type ?? "response"),
      full_request_ref: `task/${taskId}/round_${roundNumber}/request`,
      full_response_ref: `task/${taskId}/round_${roundNumber}/response`,
      in_window: true,
      cacheable: false
    });
  }

  function isUuid(value) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  function submissionRepresentation(plan = []) {
    const formats = new Set(plan.map((item) => item.action === "NEW" ? "full_content" : item.action === "MODIFY" ? "structured_patch" : null).filter(Boolean));
    return formats.size > 1 ? "per_file" : [...formats][0] ?? "per_file";
  }

  async function requestForRound(source, type, expectedType, extra = {}) {
    const origin = { ...(taskSource ?? {}), ...(source ?? {}) };
    const roundNumber = type === "task" ? 1 : type === "planning" ? 2 : 3;
    const ticket = origin.ticket ?? origin.payload?.task ?? {
      id: origin.task_id, project_id: origin.project_id ?? "PROJECT", title: source.payload?.text ?? origin.task_id,
      objective: source.payload?.text ?? origin.task_id, acceptance_criteria: source.payload?.acceptance_criteria ?? [source.payload?.text ?? origin.task_id]
    };
    const built = requestBuilder.buildTaskRequest(ticket, {
      agentId: origin.agent_id ?? "builder", conversationId, correlationId: origin.correlation_id,
      stepId: roundNumber, parentId: isUuid(origin.parent_id) ? origin.parent_id : null,
      relevantTree: origin.relevantTree ?? [], submissionFormat: origin.submissionFormat
    });
    const envelope = {
      ...built,
      task_id: origin.task_id,
      supervisor_id: source.supervisor_id,
      request_id: isUuid(origin.request_id) ? origin.request_id : built.request_id,
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
        transcript_blocks: transcriptBlocks.map((block) => ({ ...block })),
        instruction_blocks: type === "task"
          ? buildStage1InstructionBlocks({ includeTaskReview: true, includeConventions: true })
          : type === "planning"
            ? buildStage1InstructionBlocks({ includePlanning: true, includeConventions: false })
            : [{ block_id: "code_require", content: CODE_REQUIRE_INSTRUCTION, cacheable: false }, { block_id: "structured-patch-contract", content: STRUCTURED_PATCH_CONTRACT, cacheable: true }],
        ...(extra.context ? { files: extra.context } : {}),
        ...(extra.plan ? { plan: extra.plan } : {}),
        ...(roundNumber === 3 && extra.plan ? { expected_submission: { type: "submit_code", representation: submissionRepresentation(extra.plan), transport: "function_tool", required_fields: ["explanation", "files"] } } : {})
      }
    };
    transcript.push({ type: "request", round: roundNumber, request_id: envelope.request_id, payload: envelope.payload });
    if (conversationStateStore?.advanceRound && conversationId) await conversationStateStore.advanceRound(conversationId, { round: roundNumber, step: roundNumber, requestId: envelope.request_id, parentId: envelope.parent_id, status: type === "task" ? "round_1_sent" : type === "planning" ? "round_2_sent" : "round_3_sent" });
    if (protocolStorage?.save) await protocolStorage.save(`task/${origin.task_id}/round_${roundNumber}/request`, envelope, { replace: true, schemaId: "https://forge.local/schemas/agent/envelope.schema.json" });
    return envelope;
  }}
