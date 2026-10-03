// Runs an independent, read-only ticket review before a Supervisor accepts Coder work.
import { ConfigurationError } from "../../shared/errors.js";
import { isAbsolute } from "node:path";
import { createOwnerClaudeMcpTools } from "../../tools/owner-claude-mcp-tools.js";
import { createClaudeForgeOptions } from "../../tools/claude-forge-options.js";
import { assertReviewerReadPath, createReviewerForgeTools } from "./reviewer-forge-tools.js";
import { assertTicketReviewEvidence } from "./ticket-review-evidence.js";

// Creates a reviewer that receives bounded source evidence through Forge File Service.
export function createReviewWorker({ agentResolver, claudeSdkGateway, openaiSdkGateway, codexSdkGateway, fileService, rulesFileService, gitService, codeSearch, codeCache, projectRoot, executionContexts, verificationService, reviewFindings, projectLogger = () => {} } = {}) {
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
    const exchange = reviewFindings?.load ? await reviewFindings.load() : null;
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
    const patch = job.payload?.base_commit && gitService?.diffPatchFrom ? await gitService.diffPatchFrom(job.payload.base_commit, { paths }) : "";
    if (Buffer.byteLength(patch, "utf8") > 200_000) throw reviewError("REVIEW_EVIDENCE_TOO_LARGE", "Review patch exceeds the bounded evidence budget.");
    const reviewerRules = await readReviewerRules();
    const prompt = [
      "Act only as an independent code reviewer. Do not edit files. Check the ticket against the current source and verification evidence.",
      "You must follow the Reviewer role rules below before evaluating the ticket.",
      `Reviewer role rules: ${reviewerRules}`,
      ticketEvidence ? "Return only JSON with verdict (approved|request_changes), findings (objects with acceptance_criterion, failure, evidence_refs, minimum_change_scope, files when naming required files, and per_file_necessity with one concrete role per demanded file), and adjudications (objects with finding_id, decision retain|refine|withdraw|not_applicable|fixed, reason, evidence_refs). Read the Coder explanation and adjudicate each open response before deciding. A file count alone is not evidence that all files need edits." : "Return only JSON: {\"verdict\":\"approved\"|\"request_changes\",\"findings\":[\"specific finding\"]}.",
      "Approve only when the supplied evidence establishes every acceptance criterion. Request changes if evidence is insufficient.",
      `Ticket: ${JSON.stringify(job.payload?.ticket ?? {})}`,
      `Coder explanation (inspect claims against code; do not accept them as proof): ${safePromptValue(coderReport)}`,
      `Prior finding history and Coder responses (adjudicate every open response): ${safePromptValue({ findings: exchange?.findings ?? [], coder_responses: exchange?.coder_responses ?? [], adjudications: exchange?.adjudications ?? [] })}`,
      `Execution context identity: ${JSON.stringify(job.payload?.execution_context ?? null)}`,
      `Verification: ${JSON.stringify(ticketEvidence?.artifact ?? job.payload?.verification ?? {})}`,
      `Patch since ticket start (new untracked files may appear only in Changed files): ${patch || "<no tracked patch available>"}`,
      `Changed files: ${JSON.stringify(files)}`,
      job.review_only ? `Review-only target commit: ${job.payload?.commit ?? "<missing>"}` : ""
    ].join("\n\n");
    let forgeTools;
    let claudeTools;
    try {
      forgeTools = createReviewerForgeTools({ fileService, projectRoot, job, reviewer, codeSearch, codeCache, ticketEvidence, includeClaudeFileTools: ["claude", "anthropic"].includes(reviewer.provider), projectLogger });
      if (["claude", "anthropic"].includes(reviewer.provider)) claudeTools = createOwnerClaudeMcpTools(forgeTools);
    }
    catch (error) {
      forgeTools = undefined;
      projectLogger({ event_name: "review.tools_unavailable", level: "error", status: "failed", message: ticketEvidence ? "Ticket review tools unavailable; review blocked." : "Reviewer tools unavailable; using bounded review evidence.", task_id: job.task_id, correlation_id: job.correlation_id, source: "review-worker", error_code: error.code ?? "REVIEW_TOOLS_UNAVAILABLE", payload: { request_id: job.request_id, agent_id: reviewer.agent_id, agent_name: reviewer.agent_name, reviewer_id: reviewer.agent_id } });
      if (ticketEvidence) throw reviewError("REVIEW_TOOLS_UNAVAILABLE", "Ticket review tools are unavailable; approval requires committed source access.");
    }
    if (ticketEvidence && !forgeTools?.definitions.some((item) => item.name === (["claude", "anthropic"].includes(reviewer.provider) ? "Read" : "sed_lines"))) throw reviewError("REVIEW_TOOLS_UNAVAILABLE", "Ticket review requires a Forge source-window read tool.");
    const options = ["codex", "openai", "xai", "alibaba", "zhipu", "deepseek"].includes(reviewer.provider) ? { ...(forgeTools ? { forgeTools } : {}) } : claudeTools ? createClaudeForgeOptions(claudeTools) : { tools: [] };
    const toolInstruction = forgeTools ? `Forge review tools: ${forgeTools.definitions.map((item) => item.name).join(", ")}. ${forgeTools.definitions.some((item) => item.name === "search_code") ? "Use search_code to discover indexed symbols when useful. " : "Use the supplied committed file list for discovery. "}Use read_file for metadata and graph${["claude", "anthropic"].includes(reviewer.provider) ? ", and Read(file_path,start_line,end_line) for source windows of at most 80 lines" : "; use sed_lines(path,start_line,end_line) for source windows of at most 80 lines"}. For manifest files, source results carry review_evidence bound to the passed artifact and commit; reads fail if current source differs. Other reads carry no verified provenance. All reads use Forge File Service and Code Cache. Never use built-in shell, file, write, network, or ticket tools.` : "Forge review tools are unavailable. Decide only from the supplied bounded evidence; request changes when evidence is insufficient.";
    const reviewProfile = reviewer;
    projectLogger({ event_name: "review.started", level: "info", status: "started", message: "Independent Reviewer started ticket review.", task_id: job.task_id, correlation_id: job.correlation_id, source: "review-worker", payload: { request_id: job.request_id, agent_id: reviewer.agent_id, agent_name: reviewer.agent_name, reviewer_id: reviewer.agent_id, provider: reviewer.provider, changed_count: paths.length, tools: forgeTools?.definitions.map(({ name }) => name) ?? [] } });
    projectLogger({ event_name: "review.sdk_dispatch", level: "info", status: "started", message: "Reviewer SDK request dispatched.", task_id: job.task_id, correlation_id: job.correlation_id, source: "review-worker", payload: { request_id: job.request_id, agent_id: reviewer.agent_id, agent_name: reviewer.agent_name, reviewer_id: reviewer.agent_id, provider: reviewer.provider } });
    const response = await gateway.execute({ agent: reviewProfile, agentId: reviewer.agent_id, prompt: `${prompt}\n\n${toolInstruction}`, correlationId: job.correlation_id, cwd: projectRoot, options });
    projectLogger({ event_name: "review.sdk_completed", level: "info", status: "success", message: "Reviewer SDK request completed.", task_id: job.task_id, correlation_id: job.correlation_id, source: "review-worker", payload: { request_id: job.request_id, agent_id: reviewer.agent_id, agent_name: reviewer.agent_name, reviewer_id: reviewer.agent_id, provider: reviewer.provider, response_chars: String(response?.text ?? "").length } });
    const verdict = parseVerdict(response?.text, { strict: Boolean(ticketEvidence) && !job.payload?.ticket?.execution_policy?.legacy_review_report });
    if (ticketEvidence) await assertTicketReviewEvidence({ job, executionContexts, verificationService, gitService, fileService, projectRoot });
    if (verdict.verdict === "approved" && !ticketEvidence) for (const file of files) {
      await assertReviewerReadPath(projectRoot, file.path);
      const current = codeCache?.read ? await codeCache.read({ path: file.path }) : await fileService.readForIndex({ path: file.path, maxBytes: 64_000 });
      if (current.sha256 !== file.sha256) throw reviewError("REVIEW_EVIDENCE_STALE", `Source changed during review: ${file.path}.`);
    }
    projectLogger({ event_name: "review.verdict", level: "info", status: verdict.verdict, message: "Independent Reviewer returned a ticket verdict.", task_id: job.task_id, correlation_id: job.correlation_id, source: "review-worker", payload: { agent_id: reviewer.agent_id, agent_name: reviewer.agent_name, reviewer_id: reviewer.agent_id, coder_id: job.agent_id, request_id: job.request_id, findings_count: verdict.findings.length, changed_paths: paths } });
    return { ...verdict, reviewer_id: reviewer.agent_id, coder_id: job.agent_id, changed_paths: paths, source_revision: ticketEvidence?.context.source_revision ?? null };
  }

  // Loads the canonical Reviewer role contract through Forge File Service before every verdict.
  async function readReviewerRules() {
    await assertReviewerReadPath(projectRoot, "workflows/agents/reviewer/README.md");
    const file = rulesFileService?.readForIndex ? await rulesFileService.readForIndex({ path: "workflows/agents/reviewer/README.md", maxBytes: 32_000 }) : codeCache?.read ? await codeCache.read({ path: "workflows/agents/reviewer/README.md" }) : await fileService.readForIndex({ path: "workflows/agents/reviewer/README.md", maxBytes: 32_000 });
    if (!file?.content) throw reviewError("REVIEWER_RULES_UNAVAILABLE", "Reviewer role rules could not be loaded.");
    return file.content;
  }
}

// Accepts only a structured verdict, never treating free-form praise as approval.
function parseVerdict(text, { strict = false } = {}) {
  let value;
  try { value = JSON.parse(extractVerdictJson(text)); }
  catch (error) { throw reviewError("REVIEW_VERDICT_INVALID", `Reviewer returned invalid JSON: ${error.message}`); }
  if (!["approved", "request_changes"].includes(value?.verdict) || !Array.isArray(value.findings)) throw reviewError("REVIEW_VERDICT_INVALID", "Reviewer returned an invalid verdict or findings.");
  if (strict && (value.findings.some((item) => typeof item !== "object" || !item.acceptance_criterion?.trim() || !item.failure?.trim() || !item.minimum_change_scope?.trim() || !Array.isArray(item.evidence_refs) || !item.evidence_refs.length || (Array.isArray(item.per_file_necessity) && item.per_file_necessity.some((part) => !part.path || !part.role)) || (Array.isArray(item.files) && item.files.length > 1 && (!Array.isArray(item.per_file_necessity) || item.per_file_necessity.length !== item.files.length || item.per_file_necessity.some((part) => !part?.path?.trim() || !part.role?.trim())))) || !Array.isArray(value.adjudications) || value.adjudications.some((item) => !/^REV-[1-9][0-9]*$/.test(item.finding_id ?? "") || !["retain", "refine", "withdraw", "not_applicable", "fixed"].includes(item.decision) || !item.reason?.trim() || !Array.isArray(item.evidence_refs) || !item.evidence_refs.length))) throw reviewError("REVIEW_VERDICT_INVALID", "Reviewer finding or adjudication lacks required evidence and scope.");
  if (!strict && value.findings.some((item) => typeof item !== "string" || !item.trim())) throw reviewError("REVIEW_VERDICT_INVALID", "Legacy Reviewer finding is invalid.");
  if (value.verdict === "request_changes" && !value.findings.length && !(value.adjudications ?? []).some((item) => ["retain", "refine"].includes(item.decision))) throw reviewError("REVIEW_VERDICT_INVALID", "Requested changes require findings or a retained adjudication.");
  return { verdict: value.verdict, findings: value.findings, adjudications: value.adjudications ?? [] };
}

// Bounds and redacts untrusted Coder prose before dispatching it to a Reviewer.
function safePromptValue(value) {
  const raw = JSON.stringify(value ?? null);
  let output = raw.length > 32_000 ? `${raw.slice(0, 32_000)}...[TRUNCATED; inspect durable record before approval]` : raw;
  output = output.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
  for (const [name, secret] of Object.entries(process.env)) if (/(?:api.?key|secret|token|password|credential)/i.test(name) && typeof secret === "string" && secret.length >= 8) output = output.split(secret).join("[REDACTED]");
  return output;
}

// Extracts one JSON object from an SDK response that may wrap it in prose or a fenced block.
function extractVerdictJson(text) {
  const source = String(text ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  if (!source) throw new Error("empty reviewer response");
  try { JSON.parse(source); return source; } catch (error) { if (!error) throw new Error("invalid JSON"); }
  const candidates = [];
  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    const end = matchingObjectEnd(source, start);
    if (end < 0) continue;
    const candidate = source.slice(start, end + 1);
    try { const value = JSON.parse(candidate); if (value && typeof value === "object") candidates.push({ candidate, value }); } catch (error) { if (!error) throw new Error("invalid JSON candidate"); }
  }
  const verdict = candidates.find(({ value }) => typeof value.verdict === "string" && Array.isArray(value.findings));
  if (verdict) return verdict.candidate;
  throw new Error("no valid verdict object found");
}

// Finds the closing brace for one JSON object while respecting quoted strings.
function matchingObjectEnd(source, start) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

// Labels review failures so the Supervisor can escalate without accepting unreviewed work.
function reviewError(code, message) {
  return Object.assign(new ConfigurationError(message), { code });
}
