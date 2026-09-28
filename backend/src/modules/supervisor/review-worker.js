// Runs an independent, read-only ticket review before a Supervisor accepts Coder work.
import { ConfigurationError } from "../../shared/errors.js";
import { isAbsolute } from "node:path";
import { createOwnerClaudeMcpTools } from "../../tools/owner-claude-mcp-tools.js";
import { assertReviewerReadPath, createReviewerForgeTools } from "./reviewer-forge-tools.js";

// Creates a reviewer that receives bounded source evidence through Forge File Service.
export function createReviewWorker({ agentResolver, claudeSdkGateway, openaiSdkGateway, codexSdkGateway, fileService, gitService, codeSearch, codeCache, projectRoot, projectLogger = () => {} } = {}) {
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
    const gateway = reviewer.provider === "codex" ? codexSdkGateway : reviewer.provider === "openai" ? openaiSdkGateway : ["claude", "anthropic"].includes(reviewer.provider) ? claudeSdkGateway : null;
    if (!gateway?.execute) throw reviewError("REVIEWER_PROVIDER_UNAVAILABLE", "The Reviewer provider has no SDK review path.");
    const paths = [...new Set(job.payload?.changed_paths ?? [])];
    if (!paths.length || paths.length > 12) throw reviewError("REVIEW_EVIDENCE_INVALID", "Review requires one to twelve changed source files.");
    const files = [];
    let totalBytes = 0;
    for (const path of paths) {
      await assertReviewerReadPath(projectRoot, path);
      const file = codeCache?.read ? await codeCache.read({ path }) : await fileService.readForIndex({ path, maxBytes: 64_000 });
      totalBytes += file.size_bytes;
      if (totalBytes > 200_000) throw reviewError("REVIEW_EVIDENCE_TOO_LARGE", "Review source exceeds the bounded evidence budget.");
      files.push({ path: file.path, sha256: file.sha256, content: file.content });
    }
    const patch = job.payload?.base_commit && gitService?.diffPatchFrom ? await gitService.diffPatchFrom(job.payload.base_commit, { paths }) : "";
    if (Buffer.byteLength(patch, "utf8") > 200_000) throw reviewError("REVIEW_EVIDENCE_TOO_LARGE", "Review patch exceeds the bounded evidence budget.");
    const reviewerRules = await readReviewerRules();
    const prompt = [
      "Act only as an independent code reviewer. Do not edit files. Check the ticket against the current source and verification evidence.",
      "You must follow the Reviewer role rules below before evaluating the ticket.",
      `Reviewer role rules: ${reviewerRules}`,
      "Return only JSON: {\"verdict\":\"approved\"|\"request_changes\",\"findings\":[\"specific finding\"]}.",
      "Approve only when the supplied evidence establishes every acceptance criterion. Request changes if evidence is insufficient.",
      `Ticket: ${JSON.stringify(job.payload?.ticket ?? {})}`,
      `Verification: ${JSON.stringify(job.payload?.verification ?? {})}`,
      `Patch since ticket start (new untracked files may appear only in Changed files): ${patch || "<no tracked patch available>"}`,
      `Changed files: ${JSON.stringify(files)}`,
      job.review_only ? `Review-only target commit: ${job.payload?.commit ?? "<missing>"}` : ""
    ].join("\n\n");
    let forgeTools;
    let claudeTools;
    try {
      forgeTools = createReviewerForgeTools({ fileService, projectRoot, job, reviewer, codeSearch, codeCache, includeClaudeFileTools: ["claude", "anthropic"].includes(reviewer.provider), projectLogger });
      if (["claude", "anthropic"].includes(reviewer.provider)) claudeTools = createOwnerClaudeMcpTools(forgeTools);
    }
    catch (error) {
      forgeTools = undefined;
      projectLogger({ event_name: "review.tools_unavailable", level: "error", status: "failed", message: "Reviewer tools unavailable; using bounded review evidence.", task_id: job.task_id, correlation_id: job.correlation_id, source: "review-worker", error_code: error.code ?? "REVIEW_TOOLS_UNAVAILABLE", payload: { request_id: job.request_id, agent_id: reviewer.agent_id, agent_name: reviewer.agent_name, reviewer_id: reviewer.agent_id } });
    }
    const options = ["codex", "openai"].includes(reviewer.provider) ? { ...(forgeTools ? { forgeTools } : {}) } : { tools: [], ...(claudeTools ?? { allowedTools: [] }) };
    const toolInstruction = forgeTools ? `Forge review tools: ${forgeTools.definitions.map((item) => item.name).join(", ")}. Start with search_code for indexed symbols/content, then read_file for metadata and graph${["claude", "anthropic"].includes(reviewer.provider) ? ", and Read(file_path,start_line,end_line) for source windows of at most 80 lines" : "; use sed_lines(path,start_line,end_line) for source windows of at most 80 lines"}. All reads use Forge File Service and Code Cache. Never use built-in shell, file, write, network, or ticket tools.` : "Forge review tools are unavailable. Decide only from the supplied bounded evidence; request changes when evidence is insufficient.";
    const reviewProfile = reviewer;
    projectLogger({ event_name: "review.started", level: "info", status: "started", message: "Independent Reviewer started ticket review.", task_id: job.task_id, correlation_id: job.correlation_id, source: "review-worker", payload: { request_id: job.request_id, agent_id: reviewer.agent_id, agent_name: reviewer.agent_name, reviewer_id: reviewer.agent_id, provider: reviewer.provider, changed_count: paths.length, tools: forgeTools?.definitions.map(({ name }) => name) ?? [] } });
    projectLogger({ event_name: "review.sdk_dispatch", level: "info", status: "started", message: "Reviewer SDK request dispatched.", task_id: job.task_id, correlation_id: job.correlation_id, source: "review-worker", payload: { request_id: job.request_id, agent_id: reviewer.agent_id, agent_name: reviewer.agent_name, reviewer_id: reviewer.agent_id, provider: reviewer.provider } });
    const response = await gateway.execute({ agent: reviewProfile, agentId: reviewer.agent_id, prompt: `${prompt}\n\n${toolInstruction}`, correlationId: job.correlation_id, cwd: projectRoot, options });
    projectLogger({ event_name: "review.sdk_completed", level: "info", status: "success", message: "Reviewer SDK request completed.", task_id: job.task_id, correlation_id: job.correlation_id, source: "review-worker", payload: { request_id: job.request_id, agent_id: reviewer.agent_id, agent_name: reviewer.agent_name, reviewer_id: reviewer.agent_id, provider: reviewer.provider, response_chars: String(response?.text ?? "").length } });
    const verdict = parseVerdict(response?.text);
    if (verdict.verdict === "approved") for (const file of files) {
      await assertReviewerReadPath(projectRoot, file.path);
      const current = codeCache?.read ? await codeCache.read({ path: file.path }) : await fileService.readForIndex({ path: file.path, maxBytes: 64_000 });
      if (current.sha256 !== file.sha256) throw reviewError("REVIEW_EVIDENCE_STALE", `Source changed during review: ${file.path}.`);
    }
    projectLogger({ event_name: "review.verdict", level: "info", status: verdict.verdict, message: "Independent Reviewer returned a ticket verdict.", task_id: job.task_id, correlation_id: job.correlation_id, source: "review-worker", payload: { agent_id: reviewer.agent_id, agent_name: reviewer.agent_name, reviewer_id: reviewer.agent_id, coder_id: job.agent_id, request_id: job.request_id, findings_count: verdict.findings.length, changed_paths: paths } });
    return { ...verdict, reviewer_id: reviewer.agent_id, coder_id: job.agent_id, changed_paths: paths };
  }

  // Loads the canonical Reviewer role contract through Forge File Service before every verdict.
  async function readReviewerRules() {
    await assertReviewerReadPath(projectRoot, "workflows/agents/reviewer.md");
    const file = codeCache?.read ? await codeCache.read({ path: "workflows/agents/reviewer.md" }) : await fileService.readForIndex({ path: "workflows/agents/reviewer.md", maxBytes: 32_000 });
    if (!file?.content) throw reviewError("REVIEWER_RULES_UNAVAILABLE", "Reviewer role rules could not be loaded.");
    return file.content;
  }
}

// Accepts only a structured verdict, never treating free-form praise as approval.
function parseVerdict(text) {
  let value;
  try { value = JSON.parse(extractVerdictJson(text)); }
  catch (error) { throw reviewError("REVIEW_VERDICT_INVALID", `Reviewer returned invalid JSON: ${error.message}`); }
  if (!["approved", "request_changes"].includes(value?.verdict) || !Array.isArray(value.findings) || value.findings.some((item) => typeof item !== "string" || !item.trim())) throw reviewError("REVIEW_VERDICT_INVALID", "Reviewer returned an invalid verdict or findings.");
  if (value.verdict === "request_changes" && !value.findings.length) throw reviewError("REVIEW_VERDICT_INVALID", "Requested changes require specific findings.");
  return { verdict: value.verdict, findings: value.findings };
}

// Extracts one JSON object from an SDK response that may wrap it in prose or a fenced block.
function extractVerdictJson(text) {
  const source = String(text ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  if (!source) throw new Error("empty reviewer response");
  try { JSON.parse(source); return source; } catch (error) { if (!error) throw new Error("invalid JSON"); }
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object found");
  const candidate = source.slice(start, end + 1);
  JSON.parse(candidate);
  return candidate;
}

// Labels review failures so the Supervisor can escalate without accepting unreviewed work.
function reviewError(code, message) {
  return Object.assign(new ConfigurationError(message), { code });
}
