import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { createStage1TaskInitializer } from "./stage1-task-initializer.js";
import { createStage1RequestSender } from "./stage1-request-sender.js";
import { createStage1CodeNeededHandler } from "./stage1-code-needed-handler.js";
import { createStage1ResponseReceiver } from "./stage1-response-receiver.js";
import { createStage1ResponseRouter } from "./stage1-response-router.js";
import { createStage1SubmitCodeHandler } from "./stage1-submit-code-handler.js";
import { normalizeResponse } from "../agent/provider-adapters/openai-response-normalizer.js";
import { stage1AgentTools } from "./stage1-agent-tools.js";
import { createUnwiredFileChecker } from "./unwired-file-checker.js";
import { buildUsageQuery } from "./stage1-usage-query-builder.js";
import { assertValidEnvelope } from "../protocol/envelope-validator.js";
import { createRoundCounter } from "./round-counter.js";
import { logEvent } from "../../core/project-log-service.js";

/** Runs one ticket through the canonical Stage-1 protocol, without owner-chat legacy dispatch. */
export function createStage1TicketRunner({ statusStore, gitService, protocolLogger, protocolStorage, fileService, files, fileGraph, requestBuilder, agentGateway, agentProfile, credential, resolveAgentProfile, relevantTreeSelector, verificationGate, reportService, onStatusChange = () => {}, maxRounds = 15 } = {}) {
  if (!requestBuilder?.buildTaskRequest || typeof agentGateway?.request !== "function") throw new ConfigurationError("Stage-1 ticket runner requires request builder and agent gateway.");
  const initializer = createStage1TaskInitializer({ statusStore, gitService, protocolLogger });
  const roundCounter = createRoundCounter({ maxRounds });
    const sender = createStage1RequestSender({ protocolLogger, protocolStorage, roundCounter, onRoundLimit, adapterResolver: () => ({ call: async ({ payload, correlationId }) => { const tools = payload.type === "code_provide" ? stage1AgentTools.filter(({ name }) => name === "submit_code_response") : payload.type === "usage_query" ? stage1AgentTools.filter(({ name }) => ["usage_needed", "no_wiring_needed"].includes(name)) : payload.type === "status_check" ? stage1AgentTools.filter(({ name }) => ["completed", "continue"].includes(name)) : stage1AgentTools.filter(({ name }) => name === "code_needed"); const raw = await agentGateway.request({ agentId: "builder", payload, correlationId, tools });
      try {
        assertProviderCompleted(raw);
        const envelope = normalizeResponse(raw.payload ?? raw, { request_id: payload.request_id });
        Object.defineProperty(envelope, "provider_metadata", { value: Object.freeze({ provider: "openai", response_id: raw?.payload?.response_id ?? raw?.response_id ?? null, status: raw?.status ?? "completed", completed_at: raw?.completed_at ?? null, error: raw?.error ?? null, incomplete_details: raw?.incomplete_details ?? null }), enumerable: false });
        return envelope;
      } catch (error) { error.rawResponse = raw; throw error; } } }) });
  let activeRelevantTree = [];
  let formatRetries = 0;
  let formatAttempts = new Map();
  // Track format failures independently for each task and file.
  let retryCountPerFile = new Map();
  let attemptedFormats = new Set();
  let latestCommit = null;
  let baseBranch = "main";
  const codeNeeded = createStage1CodeNeededHandler({ files, fileService, relevantTree: activeRelevantTree });
  const receiver = createStage1ResponseReceiver({ protocolLogger });
  const submitCode = createStage1SubmitCodeHandler({ fileService, gitService, statusStore, protocolLogger, unwiredChecker: fileGraph ? createUnwiredChecker(fileGraph) : undefined });
  const router = createStage1ResponseRouter({
    onCodeNeeded: (response, context) => codeNeeded.handleCodeNeeded(response, context),
    onSubmitCode: (response, context) => submitCode.handleSubmitCode(response, context),
    onUsageNeeded: (response, context) => handleUsageNeeded(response, context),
    onNoWiringNeeded: (response) => ({ type: "no_wiring_needed", reason: response.payload.reason }),
    onContinue: (response, context) => handleContinue(response, context),
    onCompleted: (response, context) => handleCompleted(response, context)
  });
  return Object.freeze({ run });

  async function completeAfterCode(ticket, filesChanged, reason) {
    const current = statusStore.get(ticket.id);
    const completed = current?.status === "reviewing"
      ? statusStore.updateStatus(ticket.id, "done", { reason, files: filesChanged }, { expectedCurrentStatus: "reviewing" })
      : current;
    await publishTerminalStatus(ticket, completed?.status ?? "done");
    await persistFinalReport(ticket, completed?.status ?? "done", null, filesChanged, reason);
    return { type: "completed", files_changed: filesChanged, status: completed };
  }

  async function handleCompleted(response) { return { type: "completed", report: response.payload.report }; }

  async function handleContinue(response, context = {}) {
    const next = response?.payload?.next_task;
    if (!next?.description || !context.requestEnvelope) throw new ConfigurationError("continue requires next_task.description and the originating request envelope.");
    const original = context.requestEnvelope.payload;
    const continuedTicket = { id: original.task_id, project_id: original.metadata?.project_id ?? context.projectId ?? "PROJECT-NODEFORGE", title: ticketTitle(next.description), objective: next.description, acceptance_criteria: ["Complete the requested continuation task."] };
    return requestBuilder.buildTaskRequest(continuedTicket, { agentId: original.metadata?.agent_id ?? "builder", conversationId: original.metadata?.conversation_id, correlationId: original.metadata?.correlation_id, stepId: original.step_id + 1, parentId: context.requestEnvelope.request_id, relevantTree: activeRelevantTree, submissionFormat: original.expected_submission?.representation, cacheConfig: original.cache_config });
  }

  async function handleUsageNeeded(response, context = {}) {
    if (!context.requestEnvelope) throw new ConfigurationError("usage_needed requires the originating request envelope.");
    // Reuse the exact code-needed exchange path; only the protocol type changes.
    const codeNeededResponse = { ...response, type: "code_needed" };
    return codeNeeded.handleCodeNeeded(codeNeededResponse, context);
  }

  async function run(ticket, { conversationId = `CONV-BUILDER`, correlationId = `CORR-${ticket?.id}-${randomUUID()}` } = {}) {
    try {
      roundCounter.reset(ticket.id);
      const initialized = await initializer.initTask(ticket);
      baseBranch = initialized.base_branch ?? "main";
      if (initialized.status?.status === "blocked") return initialized;
      const profile = typeof resolveAgentProfile === "function" ? await resolveAgentProfile("builder") : agentProfile;
      const scope = inferTicketScope(ticket);
      const relevantTree = relevantTreeSelector
        ? selectInitialCandidates(relevantTreeSelector.select({ title: ticket.title, objective: ticket.objective, acceptanceCriteria: ticket.acceptance_criteria, depth: 1, limit: 30, ...scope }).tree, ticket)
        : [];
      activeRelevantTree.splice(0, activeRelevantTree.length, ...relevantTree);
      let request = requestBuilder.buildTaskRequest(ticket, { agentId: "builder", conversationId, correlationId, stepId: 1, relevantTree });
      let filesChanged = [];
      formatRetries = 0;
      formatAttempts = new Map();
      retryCountPerFile = new Map();
      attemptedFormats = new Set();
      for (;;) {
        const correlationContext = request?.payload?.metadata?.correlation_id ?? correlationId;
        let sent;
        let response;
        let result;
        try {
          sent = await sender.sendRequest(request, { agentProfile: profile, credential, correlationId: correlationContext });
          response = receiver.receiveResponse(sent.response, { requestEnvelope: request });
          result = await router.routeResponse(response, { requestEnvelope: request, taskId: ticket.id, projectId: ticket.project_id, ticketId: ticket.id, contextFiles: request.payload?.files });
        } catch (error) {
          // Only two provider rounds are allowed; preserve the failure and stop.
          if (isRetryableSubmissionError(error)) await escalateToOwner(ticket, error);
          throw error;
        }
        if (response.type === "submit_code_response") {
          latestCommit = result.commit ?? latestCommit;
          filesChanged = [...filesChanged, ...(result.files_changed ?? [])].filter((file, index, all) => all.findIndex((item) => item.path === file.path) === index);
          if (result?.unwired_files?.length) {
            request = buildUsageQuery({ taskId: ticket.id, stepId: request.payload.step_id + 1, parentId: response.request_id, projectId: ticket.project_id, conversationId, correlationId, unwiredFiles: result.unwired_files, cacheConfig: request.payload.cache_config, instructionBlocks: request.payload.instruction_blocks ?? [], userBlocks: request.payload.user_blocks ?? [] });
            continue;
          }
          if (verificationGate?.verifyAndMerge && latestCommit?.sha) {
            const verified = await verificationGate.verifyAndMerge({ taskId: ticket.id, projectId: ticket.project_id, commitId: latestCommit.sha, branch: `task/${ticket.id}`, target: baseBranch, filesChanged: filesChanged.map(({ path }) => path), scope: "targeted" });
            if (verified.status === "verification_failed") {
              if (statusStore.get(ticket.id)?.status === "reviewing") statusStore.updateStatus(ticket.id, "running", { reason: "verification_retry" }, { expectedCurrentStatus: "reviewing" });
              const error = new ConfigurationError("Verification failed for submitted code.");
              error.code = "VERIFICATION_FAILED";
              error.verification = verified.verification;
              await escalateToOwner(ticket, error);
              throw error;
            }
            if (verified.status === "merge_conflict") throw Object.assign(new ConfigurationError(verified.error ?? "Git merge conflict."), { code: "GIT_MERGE_CONFLICT" });
            if (verified.status === "merged" && typeof gitService.deleteMergedBranch === "function") {
              await gitService.deleteMergedBranch(`task/${ticket.id}`);
            }
            await persistFinalReport(ticket, verified.runtimeStatus?.status ?? "done", verified.verification, filesChanged, "verified_and_merged");
            return { type: "completed", files_changed: filesChanged, status: verified.runtimeStatus ?? statusStore.get(ticket.id), verification: verified.verification, merge: verified.merge };
          }
          return await completeAfterCode(ticket, filesChanged, "code_submitted");
        }
        if (result?.type === "no_wiring_needed") {
          if (verificationGate?.verifyAndMerge && latestCommit?.sha) {
            const verified = await verificationGate.verifyAndMerge({ taskId: ticket.id, projectId: ticket.project_id, commitId: latestCommit.sha, branch: `task/${ticket.id}`, target: baseBranch, filesChanged: filesChanged.map(({ path }) => path), scope: "targeted" });
            if (verified.status === "merge_conflict") throw Object.assign(new ConfigurationError(verified.error ?? "Git merge conflict."), { code: "GIT_MERGE_CONFLICT" });
            if (verified.status === "merged" && typeof gitService.deleteMergedBranch === "function") {
              await gitService.deleteMergedBranch(`task/${ticket.id}`);
            }
            return { type: "completed", files_changed: filesChanged, status: verified.runtimeStatus ?? statusStore.get(ticket.id), verification: verified.verification, merge: verified.merge };
          }
          return await completeAfterCode(ticket, filesChanged, "wiring_not_required");
        }
        if (response.type === "completed") {
          await protocolStorage?.save(`task/${ticket.id}/report`, result.report, { schemaId: "https://forge.local/schemas/agent/agent-completed.schema.json" });
          const current = statusStore.get(ticket.id);
          const completed = current?.status === "reviewing" ? statusStore.updateStatus(ticket.id, "done", { reason: "coder_completed", report: result.report }, { expectedCurrentStatus: "reviewing" }) : current;
          await publishTerminalStatus(ticket, completed?.status ?? "done");
          return { ...result, status: completed };
        }
        request = result;
        if (!["code_provide", "usage_query", "task"].includes(request.type)) throw new ConfigurationError(`Unsupported Stage-1 continuation: ${request.type}.`);
      }
    } catch (error) {
      const current = statusStore.get(ticket.id);
      if (["running", "reviewing"].includes(current?.status)) {
        statusStore.updateStatus(ticket.id, "failed", { reason: "stage1_error", error: error.message }, { expectedCurrentStatus: current.status });
        logEvent({ timestamp: new Date().toISOString(), event_name: "stage1.error", level: "error", status: "failed", message: error.message, task_id: ticket.id, ticket_id: ticket.id, conversation_id: conversationId, correlation_id: correlationId, source: "stage1-ticket-runner", error_code: error.code ?? "STAGE1_ERROR", payload: { error: error.message, ...(error.providerStatus ? { provider_status: error.providerStatus } : {}), ...(error.responseId ? { response_id: error.responseId } : {}) } });
        await publishTerminalStatus(ticket, "failed", error.message);
      }
      await persistFinalReport(ticket, current?.status === "needs_human_review" ? "needs_human_review" : "failed", error.verification ?? null, [], "stage1_error", error.message).catch(() => {});
      throw error;
    }
  }

  function selectInitialCandidates(tree, ticket) {
    const source = tree.filter((entry) => /^(?:backend\/src|frontend|ui\/nextjs|ui\/src|web\/src)\//.test(entry.path)).sort((left, right) => Number(right.score) - Number(left.score) || left.path.localeCompare(right.path));
    const text = [ticket.title, ticket.objective, ...(ticket.acceptance_criteria ?? [])].join(" ").toLowerCase();
    const frontendTicket = /\b(frontend|front-end)\b/.test(text);
    const uiTicket = /\b(ui|next\.js|nextjs|page|component|layout|navigation|responsive)\b/.test(text);
    if (frontendTicket) {
      const frontend = source.filter((entry) => entry.path.startsWith("frontend/"));
      return frontend.slice(0, 3);
    }
    if (!uiTicket) return source.slice(0, 3);
    const ui = source.filter((entry) => /^(?:ui\/nextjs|ui\/src|web\/src)\//.test(entry.path));
    const backend = source.filter((entry) => entry.path.startsWith("backend/src/"));
    return [...ui, ...backend].slice(0, 3);
  }

  function isRetryableSubmissionError(error) {
    return ["INVALID_PAYLOAD", "CHECKSUM_MISMATCH", "PATCH_CONTEXT_REQUIRED", "PATCH_NOT_APPLICABLE", "SUBMISSION_FORMAT_UNSUPPORTED", "UNIFIED_DIFF_INVALID", "APPLY_PATCH_INVALID", "SUBMISSION_TRUNCATED", "SYNTAX_INVALID", "STRUCTURED_PATCH_INVALID"].includes(error?.code)
      || error?.providerCode === "PROVIDER_PAYLOAD_INVALID";
  }

  function buildSubmissionRetry(previous, ticket, error, retryNumber, nextFormat = "full_content", notice = "") {
    const previousBlocks = previous.payload?.task_context?.user_blocks ?? previous.payload?.user_blocks ?? [];
    const retryInstruction = `Previous submission was rejected before writing any file: ${error.code ?? "INVALID_PAYLOAD"}: ${error.message}. Retry ${retryNumber}. Return exactly format ${nextFormat}, copy every existing file before_checksum exactly from Node context, and do not submit a shortened placeholder.${notice ? ` ${notice}` : ""}`;
    const payload = {
      ...structuredClone(previous.payload),
      step_id: previous.payload.step_id + 1,
      expected_submission: { ...(previous.payload.expected_submission ?? {}), representation: nextFormat },
      task_context: {
        instruction_blocks: structuredClone(previous.payload?.task_context?.instruction_blocks ?? previous.payload?.instruction_blocks ?? []),
        user_blocks: [...structuredClone(previousBlocks), { block_id: `submission-retry-${retryNumber}`, content: retryInstruction, cacheable: false }]
      },
      metadata: { ...(previous.payload.metadata ?? {}), retry_of_step: previous.payload.step_id, previous_error: error.message }
    };
    return assertValidEnvelope({ request_id: randomUUID(), parent_id: previous.request_id, type: "code_provide", role: "node", payload, timestamp: new Date().toISOString() });
  }

  function nextSubmissionFormat(request) {
    const current = request?.payload?.expected_submission?.representation ?? "full_content";
    const attempts = (formatAttempts.get(current) ?? 0) + 1;
    formatAttempts.set(current, attempts);
    attemptedFormats.add(current);
    const nextPatch = current === "structured_patch" ? "apply_patch" : current === "apply_patch" ? "unified_diff" : current === "unified_diff" ? "full_content" : null;
    if (nextPatch === "full_content") {
      const tooLarge = (request?.payload?.files ?? []).some((file) => Number(file.size_bytes ?? Buffer.byteLength(String(file.content ?? ""), "utf8")) > 3 * 1024);
      if (tooLarge) return null;
      return { format: "full_content", notice: "All patch formats failed; this file is within 3 KiB, so full_content is now required." };
    }
    if (nextPatch && !attemptedFormats.has(nextPatch)) return { format: nextPatch, notice: `Format ${current} failed; switch to ${nextPatch}.` };
    if (current === "full_content" && attempts < 3) return { format: "full_content", notice: `Format full_content attempt ${attempts}/3 failed; retry with the same file context.` };
    return null;
  }

  function recordFormatFailures(request) {
    for (const file of request?.payload?.files ?? []) {
      if (!file?.path) continue;
      const key = `${request?.payload?.task_id ?? "task"}:${file.path}`;
      retryCountPerFile.set(key, (retryCountPerFile.get(key) ?? 0) + 1);
    }
  }

  async function escalateToOwner(ticket, error) {
    const current = statusStore.get(ticket.id);
    if (["running", "reviewing"].includes(current?.status)) {
      statusStore.updateStatus(ticket.id, "needs_human_review", { reason: "submission_escalation_exhausted", error: error.message }, { expectedCurrentStatus: current.status });
      await publishTerminalStatus(ticket, "needs_human_review", error.message);
    }
  }

  function assertProviderCompleted(response) {
    const status = response?.status ?? "completed";
    if (status === "completed") return;
    const error = new ConfigurationError(`OpenAI Responses request is not complete: ${status}.`);
    error.providerStatus = status;
    error.responseId = response?.payload?.response_id ?? response?.response_id;
    error.providerDetail = status === "failed" ? response?.error ?? null : status === "incomplete" ? response?.incomplete_details ?? null : null;
    error.code = status === "failed" ? "PROVIDER_RESPONSE_FAILED" : status === "incomplete" ? "PROVIDER_RESPONSE_INCOMPLETE" : ["queued", "in_progress"].includes(status) ? "PROVIDER_RESPONSE_NOT_READY" : status === "cancelled" ? "PROVIDER_RESPONSE_CANCELLED" : "PROVIDER_RESPONSE_STATUS_UNSUPPORTED";
    throw error;
  }

  async function onRoundLimit(round, envelope) {
    const current = statusStore.get(round.task_id);
    if (["running", "reviewing"].includes(current?.status)) statusStore.updateStatus(round.task_id, "needs_human_review", { reason: "round_limit", round_count: round.count, max_rounds: round.max_rounds, request_id: envelope.request_id }, { expectedCurrentStatus: current.status });
    await publishTerminalStatus({ id: round.task_id, project_id: envelope.payload.metadata?.project_id }, "needs_human_review", `Round limit exceeded: ${round.count}/${round.max_rounds}.`);
  }

  function ticketTitle(description) { return description.length > 120 ? `${description.slice(0, 117)}...` : description; }

  function createUnwiredChecker(graph) { return createUnwiredFileChecker({ fileGraph: graph }); }

  function inferTicketScope(ticket) {
    const text = [ticket?.title, ticket?.objective, ...(ticket?.acceptance_criteria ?? [])].filter(Boolean).join(" ").toLowerCase();
    if (/\b(frontend|front-end)\b/.test(text)) return { scope: "frontend", allowed_prefixes: ["frontend/"] };
    if (/\b(ui|next\.js|nextjs|page|component|layout|navigation|responsive)\b/.test(text)) return { scope: "ui", allowed_prefixes: ["ui/nextjs/", "ui/src/", "web/src/"] };
    return { scope: "repository" };
  }

  async function persistFinalReport(ticket, status, verifyResult, filesChanged, reason, error = null) {
    if (!reportService?.buildFinalReport) return;
    const report = await reportService.buildFinalReport({ ticket, status, verifyResult, filesChanged, reason, error });
    await reportService.saveReport(ticket.id, report);
    await reportService.writeReportFile(ticket.id, report);
  }

  async function publishTerminalStatus(ticket, status, error) {
    if (!status || typeof onStatusChange !== "function") return;
    await onStatusChange({ projectId: ticket.project_id, ticketId: ticket.id, status, ...(error ? { error } : {}) });
  }
}
