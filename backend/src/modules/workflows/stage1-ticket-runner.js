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

/** Runs one ticket through the canonical Stage-1 protocol, without owner-chat legacy dispatch. */
export function createStage1TicketRunner({ statusStore, gitService, protocolLogger, protocolStorage, fileService, files, fileGraph, requestBuilder, agentGateway, agentProfile, credential, resolveAgentProfile, relevantTreeSelector, onStatusChange = () => {} } = {}) {
  if (!requestBuilder?.buildTaskRequest || typeof agentGateway?.request !== "function") throw new ConfigurationError("Stage-1 ticket runner requires request builder and agent gateway.");
  const initializer = createStage1TaskInitializer({ statusStore, gitService, protocolLogger });
    const sender = createStage1RequestSender({ protocolLogger, protocolStorage, adapterResolver: () => ({ call: async ({ payload, correlationId }) => { const tools = payload.type === "code_provide" ? stage1AgentTools.filter(({ name }) => name === "submit_code_response") : payload.type === "usage_query" ? stage1AgentTools.filter(({ name }) => ["usage_needed", "no_wiring_needed"].includes(name)) : stage1AgentTools.filter(({ name }) => name === "code_needed"); const raw = await agentGateway.request({ agentId: "builder", payload, correlationId, tools });
      try { return normalizeResponse(raw.payload ?? raw, { request_id: payload.request_id }); }
      catch (error) { error.rawResponse = raw; throw error; } } }) });
  let activeRelevantTree = [];
  const codeNeeded = createStage1CodeNeededHandler({ files, fileService, relevantTree: activeRelevantTree });
  const receiver = createStage1ResponseReceiver({ protocolLogger });
  const submitCode = createStage1SubmitCodeHandler({ fileService, gitService, statusStore, protocolLogger, unwiredChecker: fileGraph ? createUnwiredChecker(fileGraph) : undefined });
  const router = createStage1ResponseRouter({
    onCodeNeeded: (response, context) => codeNeeded.handleCodeNeeded(response, context),
    onSubmitCode: (response, context) => submitCode.handleSubmitCode(response, context),
    onUsageNeeded: (response, context) => handleUsageNeeded(response, context),
    onNoWiringNeeded: (response) => ({ type: "no_wiring_needed", reason: response.payload.reason })
  });
  return Object.freeze({ run });

  async function handleUsageNeeded(response, context = {}) {
    if (!context.requestEnvelope) throw new ConfigurationError("usage_needed requires the originating request envelope.");
    // Reuse the exact code-needed exchange path; only the protocol type changes.
    const codeNeededResponse = { ...response, type: "code_needed" };
    return codeNeeded.handleCodeNeeded(codeNeededResponse, context);
  }

  async function run(ticket, { conversationId = `CONV-BUILDER`, correlationId = `CORR-${ticket?.id}-${randomUUID()}` } = {}) {
    try {
      const initialized = await initializer.initTask(ticket);
      if (initialized.status?.status === "blocked") return initialized;
      const profile = typeof resolveAgentProfile === "function" ? await resolveAgentProfile("builder") : agentProfile;
      const scope = inferTicketScope(ticket);
      const relevantTree = relevantTreeSelector
        ? selectInitialCandidates(relevantTreeSelector.select({ title: ticket.title, objective: ticket.objective, acceptanceCriteria: ticket.acceptance_criteria, depth: 1, limit: 30, ...scope }).tree, ticket)
        : [];
      activeRelevantTree.splice(0, activeRelevantTree.length, ...relevantTree);
      let request = requestBuilder.buildTaskRequest(ticket, { agentId: "builder", conversationId, correlationId, stepId: 1, relevantTree });
      let wiringRounds = 0;
      for (let round = 0; round < 10; round += 1) {
        const correlationContext = request?.payload?.metadata?.correlation_id ?? correlationId;
        const sent = await sender.sendRequest(request, { agentProfile: profile, credential, correlationId: correlationContext });
        const response = receiver.receiveResponse(sent.response, { requestEnvelope: request });
        const result = await router.routeResponse(response, { requestEnvelope: request, taskId: ticket.id, projectId: ticket.project_id, ticketId: ticket.id, contextFiles: request.payload?.files });
        if (response.type === "submit_code_response") {
          if (result?.unwired_files?.length) {
            wiringRounds += 1;
            if (wiringRounds > 5) throw new ConfigurationError("Stage-1 wiring exceeded the maximum of 5 rounds.");
            request = buildUsageQuery({ taskId: ticket.id, stepId: request.payload.step_id + 1, parentId: response.request_id, projectId: ticket.project_id, conversationId, correlationId, unwiredFiles: result.unwired_files, instructionBlocks: request.payload.instruction_blocks ?? [], userBlocks: request.payload.user_blocks ?? [] });
            continue;
          }
          const current = statusStore.get(ticket.id);
          const completed = current?.status === "reviewing"
            ? statusStore.updateStatus(ticket.id, "done", { reason: "pipeline_completed" }, { expectedCurrentStatus: "reviewing" })
            : current;
          await publishTerminalStatus(ticket, completed?.status ?? "done");
          return { ...result, status: completed };
        }
        if (result?.type === "no_wiring_needed") return { ...result, status: statusStore.get(ticket.id) };
        request = result;
        if (request.type !== "code_provide") throw new ConfigurationError(`Unsupported Stage-1 continuation: ${request.type}.`);
      }
      throw new ConfigurationError("Stage-1 ticket exceeded the maximum protocol rounds.");
    } catch (error) {
      const current = statusStore.get(ticket.id);
      if (["running", "reviewing"].includes(current?.status)) {
        statusStore.updateStatus(ticket.id, "failed", { reason: "stage1_error", error: error.message }, { expectedCurrentStatus: current.status });
        await publishTerminalStatus(ticket, "failed", error.message);
      }
      throw error;
    }
  }

  function selectInitialCandidates(tree, ticket) {
    const source = tree.filter((entry) => /^(?:backend\/src|ui\/nextjs|ui\/src|web\/src)\//.test(entry.path)).sort((left, right) => Number(right.score) - Number(left.score) || left.path.localeCompare(right.path));
    const text = [ticket.title, ticket.objective, ...(ticket.acceptance_criteria ?? [])].join(" ").toLowerCase();
    const uiTicket = /\b(ui|next\.js|nextjs|frontend|front-end|page|component|layout|navigation|responsive)\b/.test(text);
    if (!uiTicket) return source.slice(0, 3);
    const ui = source.filter((entry) => /^(?:ui\/nextjs|ui\/src|web\/src)\//.test(entry.path));
    const backend = source.filter((entry) => entry.path.startsWith("backend/src/"));
    return [...ui, ...backend].slice(0, 3);
  }

  function createUnwiredChecker(graph) { return createUnwiredFileChecker({ fileGraph: graph }); }

  function inferTicketScope(ticket) {
    const text = [ticket?.title, ticket?.objective, ...(ticket?.acceptance_criteria ?? [])].filter(Boolean).join(" ").toLowerCase();
    if (/\b(ui|next\.js|nextjs|frontend|front-end|page|component|layout|navigation|responsive)\b/.test(text)) return { scope: "ui", allowed_prefixes: ["ui/nextjs/", "ui/src/", "web/src/"] };
    return { scope: "repository" };
  }

  async function publishTerminalStatus(ticket, status, error) {
    if (!status || typeof onStatusChange !== "function") return;
    await onStatusChange({ projectId: ticket.project_id, ticketId: ticket.id, status, ...(error ? { error } : {}) });
  }
}
