// Runs an independent, read-only ticket review before a Supervisor accepts Coder work.
import { ConfigurationError } from "../../shared/errors.js";
import { isAbsolute } from "node:path";
import { createOwnerClaudeMcpTools } from "../../tools/owner-claude-mcp-tools.js";
import { createClaudeForgeOptions } from "../../tools/claude-forge-options.js";
import { assertReviewerReadPath, createReviewerForgeTools } from "./reviewer-forge-tools.js";
import { assertTicketReviewEvidence } from "./ticket-review-evidence.js";
import { requestReviewVerdict, reviewVerdictInstructions } from "./review-verdict-request.js";
import { REVIEW_AUTONOMY_PROMPT } from "../../shared/implementation-autonomy.js";
import { createCommittedReviewSource } from "./reviewer-committed-source.js";
import { createReviewTransportObserver, reviewOperationalFailure } from "./review-operational-failure.js";
import { readBlockerContracts, blockerContractPrompt } from "./blocker-contract-evidence.js";
import { createReviewExchangeEvidence, attachReviewExchangeTools } from "./review-exchange-evidence.js";

// Creates a reviewer that receives bounded source evidence through Forge File Service.
export function createReviewWorker({ agentResolver, claudeSdkGateway, openaiSdkGateway, codexSdkGateway, fileService, contractFileService, rulesFileService, gitService, codeSearch, codeCache, projectRoot, executionContexts, verificationService, reviewFindings, checkpoints, projectLogger = () => {} } = {}) {
  if (typeof agentResolver?.resolveAvailable !== "function" || typeof fileService?.readForIndex !== "function" || typeof projectRoot !== "string" || !isAbsolute(projectRoot)) throw new ConfigurationError("Review Worker requires profiles, File Service, and an absolute project root.");
  return Object.freeze({ review });

  // Requests one explicit verdict from a Reviewer who did not author the change.
  async function review(job) {
    agentResolver.refresh?.();
    const reviewer = job.reviewer_id
      ? agentResolver.list?.("reviewer")?.find((profile) => profile.agent_id === job.reviewer_id && profile.enabled && ["ready", "working"].includes(profile.status))
      : agentResolver.resolveAvailable("reviewer");
    if (!reviewer || reviewer.agent_id === job.agent_id) throw reviewError("REVIEWER_NOT_AVAILABLE", "An independent ready Reviewer is required.");
    // Codex review uses the OpenAI Agents SDK tool allowlist: Codex CLI cannot disable built-in shell tools.
    const gateway = reviewer.provider === "codex" ? codexSdkGateway : ["openai", "xai", "alibaba", "zhipu", "deepseek"].includes(reviewer.provider) ? openaiSdkGateway : ["claude", "anthropic"].includes(reviewer.provider) ? claudeSdkGateway : null;
    if (!gateway?.execute) throw reviewError("REVIEWER_PROVIDER_UNAVAILABLE", "The Reviewer provider has no SDK review path.");
    const ticketEvidence = executionContexts ? await assertTicketReviewEvidence({ job, executionContexts, verificationService, gitService, fileService, projectRoot }) : null;
    const exchange = reviewFindings?.load ? await (reviewFindings.loadQuery ?? reviewFindings.load)() : null;
    const exchangeEvidence = createReviewExchangeEvidence(job.task_id, exchange);
    const coderReport = ticketEvidence ? (exchange?.coder_reports ?? []).filter((entry) => entry.artifact_id === ticketEvidence.artifact.artifact_id).at(-1) ?? null : (exchange?.coder_reports ?? []).at(-1) ?? null;
    if (ticketEvidence && !coderReport && !job.payload?.ticket?.execution_policy?.legacy_review_report) throw reviewError("CODER_EXPLANATION_MISSING", "Reviewer needs the Coder's durable explanation before issuing findings.");
    if (ticketEvidence?.context.state === "verified") await executionContexts.update(job.task_id, ticketEvidence.context.version, { state: "reviewing" });
    const paths = ticketEvidence?.paths ?? [...new Set(job.payload?.changed_paths ?? [])];
    if (!paths.length || paths.length > 24) throw reviewError("REVIEW_EVIDENCE_INVALID", "Review requires one to twenty-four bounded source files.");
    const files = ticketEvidence?.files ?? [];
    let totalBytes = 0;
    for (const path of ticketEvidence ? [] : paths) {
      await assertReviewerReadPath(projectRoot, path);
      const file = codeCache?.read ? await codeCache.read({ path }) : await fileService.readForIndex({ path, maxBytes: 64_000 });
      totalBytes += file.size_bytes;
      if (totalBytes > 200_000) throw reviewError("REVIEW_EVIDENCE_TOO_LARGE", "Review source exceeds the bounded evidence budget.");
      files.push({ path, sha256: file.sha256, content: file.content });
    }
    const baseCommit = ticketEvidence?.context.base_sha ?? job.payload?.base_commit;
    const patchSource = ticketEvidence ? createCommittedReviewSource({ projectRoot, commit: ticketEvidence.context.review_commit_sha, baseCommit }) : gitService;
    const patch = baseCommit && patchSource?.diffPatchFrom ? await patchSource.diffPatchFrom(baseCommit, { paths }) : "";
    if (Buffer.byteLength(patch, "utf8") > 200_000) throw reviewError("REVIEW_EVIDENCE_TOO_LARGE", "Review patch exceeds the bounded evidence budget.");
    const reviewerRules = await readReviewerRules();
    const contracts = await readBlockerContracts({ receipts: job.payload?.contract_decisions, fileService: contractFileService ?? fileService, allowContinuation: true,
      binding: { project_id: job.project_id, task_id: job.task_id, execution_id: job.payload?.execution_id, sprint_basis: job.payload?.sprint_basis } });
    const filesTotalBytes = files.reduce((sum, file) => sum + (file.content ? Buffer.byteLength(file.content, "utf8") : 0), 0);
    const promptFiles = filesTotalBytes > 64_000
      ? files.map((file) => ({ path: file.path, sha256: file.sha256, deleted: Boolean(file.deleted), line_count: file.content ? file.content.split("\n").length : 0, notice: "Full file omitted from initial prompt (>64 KB total); use review_diff, read_file, or read_lines to inspect." }))
      : files;
    const prompt = [
      blockerContractPrompt(contracts),
      "Act only as an independent code reviewer. Do not edit files. Check the ticket against the current source and verification evidence.",
      "You must follow the Reviewer role rules below before evaluating the ticket.",
      `Reviewer role rules: ${reviewerRules}`,
      REVIEW_AUTONOMY_PROMPT,
      "Return only JSON with verdict (approved|request_changes), findings (objects with acceptance_criterion, failure, evidence_refs identifying source locations or verification artifacts, minimum_change_scope, files when naming required files, and per_file_necessity with one concrete role per demanded file), and adjudications (objects with finding_id, decision retain|refine|reopen|withdraw|not_applicable|fixed, reason, evidence_refs). Read the Coder explanation and adjudicate each open response before deciding. Legacy finding strings require re-review, not invented evidence. A file count alone is not evidence that all files need edits.",
      reviewVerdictInstructions(exchange),
      "Approve only when the supplied evidence establishes every acceptance criterion. Request changes if evidence is insufficient. Temporary HTTP 429/502/503/504 or connection failures are incomplete review attempts, not implementation findings. Node retains the verified source for Reviewer retry; do not request Coder edits or a new commit solely for a transport failure.",
      "Read related project source, AGENTS.md and applicable contracts even outside the changed-file delta; project access is read-only. Use list_files for file discovery and search_text for scoped content search when available. Search discovery may reflect current filenames or a newer index; confirm claims against the committed source and supplied fixed-revision patch. git_status and git_diff inspect only approved paths in the current working tree, not the verified commit; never treat them as verification evidence. Git write operations are not available.",
      'Each per_file_necessity entry must use {"path":"project/relative/file","role":"concrete necessity"}, not a "file" key.',
      `Ticket: ${JSON.stringify(job.payload?.ticket ?? {})}`,
      `Coder explanation reference (retrieve with query_review before deciding): ${JSON.stringify(coderReport ? { kind: "report", id: coderReport.idempotency_key ?? coderReport.artifact_id, artifact_id: coderReport.artifact_id, commit_sha: coderReport.review_commit_sha } : null)}`,
      exchangeEvidence.prompt,
      `Execution context identity: ${JSON.stringify(job.payload?.execution_context ?? null)}`,
      `Verification: ${JSON.stringify(ticketEvidence?.artifact ?? job.payload?.verification ?? {})}`,
      "Evidence scopes: artifact.changed_paths is the latest ticket commit delta; file_checksums and the supplied manifest bind the tracked files at the reviewed revision. The fixed patch spans base_sha to review commit and can include earlier repair commits. Different file counts alone do not establish missing commits or bad checksums. Inspect exact source/hash evidence; this explanation does not waive missing dependency provenance or acceptance coverage.",
      "Verification scope: ticket acceptance checks must pass. Supplemental regression receipts marked preexisting_failure include the same failure reproduced on base_sha with the same recorded project environment; their nonzero exit is retained evidence, not a missing ticket repair. Do not demand unrelated project fixes solely because such a receipt exists. New or changed regressions and missing acceptance coverage remain blockers; cite concrete source or baseline evidence if disputing attribution.",
      `Patch since ticket start${ticketEvidence ? " (fixed verified base-to-review commit)" : " (new untracked files may appear only in Changed files)"}: ${patch || "<no tracked patch available>"}`,
      `Changed files: ${JSON.stringify(promptFiles)}`,
      job.review_only ? `Review-only target commit: ${job.payload?.commit ?? "<missing>"}` : ""
    ].join("\n\n");
    const transport = createReviewTransportObserver();
    const reviewState = { sessionId: null, threadId: null, turnCount: 0, lastTool: null, completedTools: [], turnHistory: [] };
    const previousReview = await checkpoints?.loadReview?.(job.task_id);
    const retained = previousReview?.status === "failed" && ["REVIEW_VERDICT_INVALID", "REVIEW_FINDINGS_INVALID", "REVIEW_FINDINGS_UNRESOLVED", "REVIEW_ADJUDICATION_INVALID", "REVIEW_ADJUDICATION_MISSING", "REVIEW_ADJUDICATION_STALE"].includes(previousReview.last_error?.code)
      && previousReview.task_id === job.task_id
      && previousReview.reviewer_id === reviewer.agent_id && previousReview.commit === ticketEvidence?.artifact.commit_sha
      && previousReview.verification?.artifact_id === ticketEvidence?.artifact.artifact_id
      && ["project_id", "source_revision", "manifest_sha", "base_sha"].every((field) => previousReview.verification[field] === ticketEvidence.artifact[field])
      ? previousReview.verdict_attempts?.findLast((attempt) => attempt.response_text && !attempt.truncated) : null;
    if (retained) Object.assign(reviewState, { sessionId: previousReview.session_id, threadId: previousReview.thread_id,
      turnCount: previousReview.last_completed_turn ?? 0, lastTool: previousReview.last_tool, completedTools: previousReview.completed_tools ?? [], turnHistory: previousReview.turn_history ?? [] });
    const verdictAttempts = retained ? [...previousReview.verdict_attempts] : [];
    const saveReviewProgress = (extra = {}) => {
      if (!checkpoints?.saveReview || !job?.task_id) return Promise.resolve(null);
      // eslint-disable-next-line no-silent-catch -- Best-effort Reviewer progress checkpoint; never fail review execution for checkpoint persistence.
      return checkpoints.saveReview({
        task_id: job.task_id, phase: "review", status: "in_progress", verdict: null,
        reviewer_id: reviewer.agent_id, reviewer_name: reviewer.agent_name ?? null, provider: reviewer.provider ?? null,
        coder_id: job.agent_id ?? null, attempt: job.attempt ?? 1, review_attempt: job.review_attempt ?? ((job.outcomes?.length ?? 0) + 1),
        request_id: job.request_id ?? null, correlation_id: job.correlation_id ?? null,
        session_id: reviewState.sessionId, thread_id: reviewState.threadId,
        last_completed_turn: reviewState.turnCount, last_tool: reviewState.lastTool,
        completed_tools: [...reviewState.completedTools], turn_history: [...reviewState.turnHistory],
        changed_paths: paths, base_commit: baseCommit ?? null, commit: ticketEvidence?.context.review_commit_sha ?? job.payload?.commit ?? null,
        verification: ticketEvidence?.artifact ?? job.payload?.verification ?? null,
        execution_context: ticketEvidence?.context ?? job.payload?.execution_context ?? null,
        verdict_attempts: verdictAttempts,
        ...(job.review_only ? { review_only: true } : {}), last_error: null, ...extra
      }).catch(() => null);
    };
    let forgeTools;
    let claudeTools;
    try {
      forgeTools = createReviewerForgeTools({ fileService, projectRoot, job, reviewer, codeSearch, codeCache, gitService, ticketEvidence, projectLogger });
      forgeTools = attachReviewExchangeTools(forgeTools, exchangeEvidence, { job, reviewer, projectLogger });
      if (forgeTools?.registry) forgeTools = { ...forgeTools, registry: checkpointedReviewRegistry(forgeTools.registry, reviewState, saveReviewProgress, transport) };
      if (["claude", "anthropic"].includes(reviewer.provider)) claudeTools = createOwnerClaudeMcpTools(forgeTools);
    }
    catch (error) {
      forgeTools = undefined;
      projectLogger({ event_name: "review.tools_unavailable", level: "error", status: "failed", message: ticketEvidence ? "Ticket review tools unavailable; review blocked." : "Reviewer tools unavailable; using bounded review evidence.", task_id: job.task_id, correlation_id: job.correlation_id, source: "review-worker", error_code: error.code ?? "REVIEW_TOOLS_UNAVAILABLE", payload: { request_id: job.request_id, agent_id: reviewer.agent_id, agent_name: reviewer.agent_name, reviewer_id: reviewer.agent_id } });
      if (ticketEvidence) throw reviewError("REVIEW_TOOLS_UNAVAILABLE", "Ticket review tools are unavailable; approval requires committed source access.");
    }
    if (ticketEvidence && !forgeTools?.definitions.some((item) => item.name === "read_lines")) throw reviewError("REVIEW_TOOLS_UNAVAILABLE", "Ticket review requires a Forge source-window read tool.");
    const options = ["codex", "openai", "xai", "alibaba", "zhipu", "deepseek"].includes(reviewer.provider) ? { ...(forgeTools ? { forgeTools } : {}) } : claudeTools ? createClaudeForgeOptions(claudeTools) : { tools: [] };
    const correctionTools = { definitions: [], registry: {}, context: forgeTools?.context ?? {} };
    const correctionOptions = ["claude", "anthropic"].includes(reviewer.provider)
      ? createClaudeForgeOptions(createOwnerClaudeMcpTools(correctionTools)) : { forgeTools: correctionTools };
    const toolInstruction = forgeTools ? `Forge review tools: ${forgeTools.definitions.map((item) => item.name).join(", ")}. Use search_tree and list_files to discover files, search_text to search content, read_file for metadata or source, and read_lines(path,start_line,end_line) for source windows of at most 80 lines. Each tool response must fit 16,000 bytes, with 128,000 bytes total per review; use smaller read_lines windows for large files rather than repeatedly requesting full read_file output. Use query_review for exact historical findings and reports; follow its cursor until complete rather than reading evidence JSON files. For manifest files, source results carry review_evidence bound to the passed artifact and commit; reads fail if source differs. Other reads carry no verified provenance. git_status and git_diff inspect approved paths in the current working tree, not the verified commit. Never use built-in shell, file, write, network, or ticket tools.` : "Forge review tools are unavailable. Decide only from the supplied bounded evidence; request changes when evidence is insufficient.";
    const reviewProfile = reviewer;
    await saveReviewProgress();
    projectLogger({ event_name: "review.started", level: "info", status: "started", message: "Independent Reviewer started ticket review.", task_id: job.task_id, correlation_id: job.correlation_id, source: "review-worker", payload: { request_id: job.request_id, agent_id: reviewer.agent_id, agent_name: reviewer.agent_name, reviewer_id: reviewer.agent_id, provider: reviewer.provider, changed_count: paths.length, tools: forgeTools?.definitions.map(({ name }) => name) ?? [] } });
    projectLogger({ event_name: "review.sdk_dispatch", level: "info", status: "started", message: "Reviewer SDK request dispatched.", task_id: job.task_id, correlation_id: job.correlation_id, source: "review-worker", payload: { request_id: job.request_id, agent_id: reviewer.agent_id, agent_name: reviewer.agent_name, reviewer_id: reviewer.agent_id, provider: reviewer.provider } });
    let verdict;
    try {
      verdict = await requestReviewVerdict({ prompt: `${prompt}\n\n${toolInstruction}`, exchange, retained,
        validate: async (value) => { transport.assertAvailable(); return ticketEvidence && reviewFindings?.validateReview ? reviewFindings.validateReview({ ...value,
          artifactId: ticketEvidence.artifact.artifact_id, commitSha: ticketEvidence.artifact.commit_sha,
          reviewerId: reviewer.agent_id, sourceRevision: ticketEvidence.artifact.source_revision }) : undefined; },
        parseOptions: { strict: Boolean(ticketEvidence) && !job.payload?.ticket?.execution_policy?.legacy_review_report,
          paths, artifactId: ticketEvidence?.artifact.artifact_id, findingIds: exchange ? (exchange.findings ?? []).map((finding) => finding.finding_id) : undefined,
          pendingResponses: (exchange?.coder_responses ?? []).flatMap((entry) => entry.responses.map((response) => ({ finding_id: response.finding_id, response_id: entry.idempotency_key })))
            .filter((response) => !(exchange?.adjudications ?? []).some((decision) => decision.finding_id === response.finding_id && decision.response_id === response.response_id)) },
        revalidate: async () => { if (ticketEvidence) await assertTicketReviewEvidence({ job, executionContexts, verificationService, gitService, fileService, projectRoot }); },
        onAttempt: async (attempt) => {
          verdictAttempts.push({ ...attempt, recorded_at: new Date().toISOString() });
          await saveReviewProgress();
          projectLogger({ event_name: attempt.status === "invalid" ? "review.verdict_correction" : "review.sdk_completed", level: attempt.status === "invalid" ? "warn" : "info", status: attempt.status,
            message: attempt.status === "invalid" ? attempt.correction < 2 ? "Reviewer output rejected; returning exact JSON diagnostics to the same Reviewer." : "Reviewer format correction exhausted; response retained at checkpoint, no verdict accepted." : "Reviewer SDK request completed.", task_id: job.task_id, correlation_id: job.correlation_id,
            payload: { request_id: job.request_id, agent_id: reviewer.agent_id, agent_name: reviewer.agent_name, reviewer_id: reviewer.agent_id, provider: reviewer.provider, correction: attempt.correction, error: attempt.error, response_chars: attempt.response_text.length } });
        },
        execute: async (requestPrompt, correction) => { const response = await gateway.execute({
        agent: reviewProfile, agentId: reviewer.agent_id, prompt: requestPrompt,
        correlationId: job.correlation_id, cwd: projectRoot, onEvent: transport.observe,
        ...(correction && reviewer.provider === "codex" && reviewState.threadId ? { resumeThreadId: reviewState.threadId } : {}),
        ...(correction && ["claude", "anthropic"].includes(reviewer.provider) && reviewState.sessionId ? { resumeSessionId: reviewState.sessionId } : {}),
        onSessionReady: (id) => {
          if (typeof id === "string" && id) { if (reviewer.provider === "codex") reviewState.threadId = id; else reviewState.sessionId = id; }
          void saveReviewProgress();
        },
        options: correction ? correctionOptions : options
      }); transport.assertAvailable(); return response; } });
      if (ticketEvidence) await assertTicketReviewEvidence({ job, executionContexts, verificationService, gitService, fileService, projectRoot });
      if (verdict.verdict === "approved" && !ticketEvidence) for (const file of files) {
        await assertReviewerReadPath(projectRoot, file.path);
        const current = codeCache?.read ? await codeCache.read({ path: file.path }) : await fileService.readForIndex({ path: file.path, maxBytes: 64_000 });
        if (current.sha256 !== file.sha256) throw reviewError("REVIEW_EVIDENCE_STALE", `Source changed during review: ${file.path}.`);
      }
    } catch (error) {
      await saveReviewProgress({ status: "failed", last_error: { code: error.code ?? "REVIEW_FAILED", message: error.message } });
      throw error;
    }
    projectLogger({ event_name: "review.verdict", level: "info", status: verdict.verdict, message: "Independent Reviewer returned a ticket verdict.", task_id: job.task_id, correlation_id: job.correlation_id, source: "review-worker", payload: { agent_id: reviewer.agent_id, agent_name: reviewer.agent_name, reviewer_id: reviewer.agent_id, coder_id: job.agent_id, request_id: job.request_id, findings_count: verdict.findings.length, changed_paths: paths } });
    return { ...verdict, reviewer_id: reviewer.agent_id, reviewer_name: reviewer.agent_name ?? null, provider: reviewer.provider ?? null, coder_id: job.agent_id, changed_paths: paths, source_revision: ticketEvidence?.context.source_revision ?? null, session_id: reviewState.sessionId, thread_id: reviewState.threadId, last_completed_turn: reviewState.turnCount, last_tool: reviewState.lastTool, completed_tools: [...reviewState.completedTools], turn_history: [...reviewState.turnHistory] };
  }

  // Loads the canonical Reviewer role contract through Forge File Service before every verdict.
  async function readReviewerRules() {
    await assertReviewerReadPath(projectRoot, "workflows/agents/reviewer/README.md");
    const file = rulesFileService?.readForIndex ? await rulesFileService.readForIndex({ path: "workflows/agents/reviewer/README.md", maxBytes: 32_000 }) : codeCache?.read ? await codeCache.read({ path: "workflows/agents/reviewer/README.md" }) : await fileService.readForIndex({ path: "workflows/agents/reviewer/README.md", maxBytes: 32_000 });
    if (!file?.content) throw reviewError("REVIEWER_RULES_UNAVAILABLE", "Reviewer role rules could not be loaded.");
    return file.content;
  }
}

// Wraps Reviewer Forge tools so each completed tool call is recorded in the Reviewer checkpoint.
function checkpointedReviewRegistry(registry, state, saveProgress, transport) {
  return Object.fromEntries(Object.entries(registry).map(([name, tool]) => [name, typeof tool?.execute !== "function" ? tool : {
    ...tool,
    execute: async (input, context) => {
      try {
        const result = await tool.execute(input, context);
        recordReviewTurn(state, name, input, typeof result?.total_lines === "number" ? `read ok (${result.total_lines} lines)` : "ok");
        await saveProgress();
        return result;
      } catch (error) {
        const outage = reviewOperationalFailure(error);
        if (outage) transport.observe({ item: { type: "mcp_tool_call", status: "failed", error: outage } });
        recordReviewTurn(state, name, input, `failed: ${error?.code ?? "REVIEW_TOOL_FAILED"}`);
        await saveProgress();
        throw error;
      }
    }
  }]));
}

// Appends a bounded turn entry for Reviewer tool telemetry without storing file contents.
function recordReviewTurn(state, tool, input, outcome) {
  const target = String(input?.path ?? input?.query ?? input?.symbol ?? "").slice(0, 160);
  state.turnCount += 1;
  state.lastTool = tool;
  state.completedTools.push(tool);
  state.turnHistory.push({ turn: state.turnCount, tool, target, outcome });
  while (state.turnHistory.length > 12) state.turnHistory.shift();
}

// Labels review failures so the Supervisor can escalate without accepting unreviewed work.
function reviewError(code, message) {
  return Object.assign(new ConfigurationError(message), { code });
}
