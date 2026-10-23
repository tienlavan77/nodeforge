// Keeps recovery requests small while retaining exact authority, denial and diagnostic text through existing read-only Forge tools.
import { createHash } from "node:crypto";
import { createFileService } from "../../infrastructure/filesystem/file-service.js";
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";

// Binds immutable context bytes independently of agent wording or mutable source revisions.
const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

// Marks abbreviated display values explicitly; the immutable section snapshots remain the complete evidence, never a new approval.
export function compactBlockerPromptValue(value) {
  if (typeof value === "string" && value.length > 800) return { excerpt: value.slice(0, 800), omitted_characters: value.length - 800, read_full_section_before_deciding: true };
  if (Array.isArray(value)) return [...value.slice(0, 16).map(compactBlockerPromptValue), ...(value.length > 16
    ? [{ omitted_items: value.length - 16, read_full_section_before_deciding: true }] : [])];
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, compactBlockerPromptValue(entry)]));
  return value;
}

// Eliminates duplicate ticket text and raw test output while preserving every criterion ID, status, binding and evidence path.
function progressView(job) {
  const progress = structuredClone(job.ticket_progress ?? null);
  if (!progress) return null;
  progress.criteria = progress.criteria?.map((criterion) => {
    const entry = { ...criterion };
    delete entry.criterion; delete entry.checks;
    return { ...entry, definition: `request.ticket.acceptance_criteria[${Number(entry.criterion_id?.slice(3)) - 1}]`,
      verification_plan_indexes: (criterion.checks ?? []).map((check) => (job.request.ticket.verification_plan ?? []).findIndex((step) => JSON.stringify(step) === JSON.stringify(check))) };
  });
  if (job.contract_context || job.architecture_response) {
    delete progress.architecture_decision;
    delete progress.settled_decisions;
  }
  if (progress.source_reconciliation?.files) progress.source_reconciliation.files = progress.source_reconciliation.files.map((entry) => ({
    path: entry.path, latest_sha: entry.latest_sha, comparison: entry.comparison, reconciliation_status: entry.source_reconciliation?.status,
    operation_count: entry.operations?.length ?? 0, full_journal_section: "ticket_progress" }));
  if (progress.verification) {
    // Output stays in hash-bound receipts already exposed through canonical read tools, rather than being repeated in every recovery request.
    const receipts = (entries) => entries?.map((record) => {
      const entry = { ...record };
      for (const key of ["stdout", "stderr", "stdout_redacted", "stderr_redacted"]) delete entry[key];
      return { ...entry, output_delivery: "Read the exact evidence_ref for complete command output." };
    });
    for (const key of ["checks", "historical_checks", "historical_artifacts"]) progress.verification[key] = receipts(progress.verification[key]);
    if (progress.verification.diagnostic) progress.verification.diagnostic.commands = receipts(progress.verification.diagnostic.commands);
  }
  return progress;
}

// Persists small immutable JSON parts so each omitted section can be read without introducing a new tool or broad runtime access.
export async function createBlockerPromptContext({ job, failureEvidence, projectRoot }) {
  const projectId = job.request?.project_id, taskId = job.request?.task_id;
  if (!projectId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(taskId ?? "")) {
    // Older unbound diagnostic callers retain their existing behavior; production jobs always carry a project-bound execution.
    return { job, failureEvidence, refs: [], summary: "" };
  }
  const files = createFileService({ projectRoot, role: "system_engineer" });
  const sections = { ticket_progress: job.ticket_progress, authority_context: job.authority_context, contract_context: job.contract_context,
    architecture_response: job.architecture_response, history: job.history, failure_evidence: failureEvidence,
    ticket: job.request.ticket, technical_reconciliation: job.technical_reconciliation, resolution: job.resolution,
    disposition_attempts: job.validation_feedback ? job.disposition_attempts?.slice(-1) : [], discovery_checkpoints: job.discovery_checkpoints,
    owner_decisions: job.owner_decisions, coder_exchange: job.coder_exchange, execution_admission: job.execution_admission,
    message: job.message, evidence: job.evidence, validation_feedback: job.validation_feedback, coder_checkpoint: job.coder_checkpoint,
    coordination_feedback: job.coordination_feedback, waiting_assignments: job.waiting_assignments, waiting_work_history: job.waiting_work_history,
    consultation_request: job.consultation_request };
  const refs = [], indexes = [];
  for (const [section, value] of Object.entries(sections)) {
    if (value === undefined || value === null) continue;
    const content = JSON.stringify(value, null, 2);
    const parts = content.match(/[\s\S]{1,4000}/gu) ?? [];
    for (const [index, part] of parts.entries()) {
      const record = { project_id: projectId, task_id: taskId, job_id: job.id, execution_id: job.request.payload?.execution_id ?? null,
        source_revision: job.request.execution_context?.source_revision ?? null, section, part: index + 1, total_parts: parts.length,
        content_lines: part.match(/[\s\S]{1,160}/gu) ?? [] };
      refs.push(await persistContextPart(files, record));
    }
    const sectionRefs = refs.filter((entry) => entry.section === section);
    for (let offset = 0; offset < sectionRefs.length; offset += 8) {
      const record = { project_id: projectId, task_id: taskId, job_id: job.id, execution_id: job.request.payload?.execution_id ?? null,
        source_revision: job.request.execution_context?.source_revision ?? null, section, part: 0, total_parts: parts.length,
        index_page: offset / 8 + 1, total_pages: Math.ceil(parts.length / 8), parts: sectionRefs.slice(offset, offset + 8) };
      const ref = await persistContextPart(files, record);
      refs.push(ref); indexes.push({ ...ref, index_page: record.index_page, total_pages: record.total_pages });
    }
  }
  const view = { ...job, ticket_progress: progressView(job),
    history: (job.history ?? []).slice(-8).map(({ stage, event, completed_at, outcome_reason, disposition }) => ({ stage, event, completed_at, outcome_reason,
      action: disposition?.action, summary: disposition?.summary })),
    authority_context: job.authority_context ? { file_claims: job.authority_context.file_claims,
      architecture: job.authority_context.architecture ? { basis: job.authority_context.architecture.basis } : null,
      passages: job.authority_context.passages?.map(({ passage_id, scope, text }) => ({ passage_id, scope,
        ...(text.length <= 240 ? { text } : { text_excerpt: text.slice(0, 240), read_full_passage_from_section: "authority_context" }) })) } : undefined,
    request: { ...job.request, ticket: compactBlockerPromptValue(job.request.ticket) },
    disposition_attempts: job.validation_feedback ? job.disposition_attempts?.slice(-1) : [] };
  for (const key of Object.keys(sections)) if (key !== "ticket" && key !== "failure_evidence" && key in view) view[key] = compactBlockerPromptValue(view[key]);
  const minimalJob = { ...view, request: { ...job.request, ticket: { id: job.request.ticket.id, title: job.request.ticket.title, full_definition_section: "ticket" } },
    ticket_progress: { execution_id: job.ticket_progress?.execution_id, source_revision: job.ticket_progress?.source_revision,
      last_completed_turn: job.ticket_progress?.last_completed_turn, evidence_sha256: job.ticket_progress?.evidence_sha256, full_definition_section: "ticket_progress" },
    contract_context: "Read the contract_context section for exact retained AM decisions before resolving a contract question.",
    architecture_response: undefined, history: [], owner_decisions: [{ full_definition_section: "owner_decisions" }],
    coder_exchange: job.coder_exchange ? { request_id: job.coder_exchange.request_id, full_definition_section: "coder_exchange" } : undefined,
    execution_admission: job.execution_admission ? { sha256: job.execution_admission.sha256, status: job.execution_admission.status,
      decision: { verdict: job.execution_admission.decision?.verdict, operation: job.execution_admission.decision?.operation }, full_definition_section: "execution_admission" } : undefined,
    technical_reconciliation: undefined, discovery_checkpoints: undefined, disposition_attempts: [], validation_feedback: [],
    coder_checkpoint: { last_completed_turn: job.coder_checkpoint?.last_completed_turn, full_definition_section: "coder_checkpoint" },
    waiting_work_history: [], waiting_assignments: [{ full_definition_section: "waiting_assignments" }], coordination_feedback: "Read coordination_feedback section.",
    message: "Read message and failure_evidence sections for the original failure, including any denied operation.", evidence: [] };
  return { job: view, minimalJob, failureEvidence: compactBlockerPromptValue(failureEvidence), refs,
    summary: `READ-ONLY FULL CONTEXT INDEX: ${JSON.stringify(indexes)}\nDisplay excerpts are incomplete and grant no authority. Before deciding an unclear contract, denial or acceptance requirement, use read_file/read_lines on its section index, then read the listed parts. Join content_lines within each part and parts in order to recover the original JSON/text. Part hashes and assignment identities are enforced by Node. Context copies are delivery references, not implementation evidence: cite original source/check receipts and Node-issued authority passage IDs in dispositions. Criteria and verification definitions occur once in request.ticket; progress uses their positional IDs/indexes. Full test output stays at verification evidence_ref. Do not request a missing document that this index or an issued receipt already supplies.` };
}

// Reuses identical immutable snapshots quietly and rejects a conflicting existing object before granting any read reference.
async function persistContextPart(files, record) {
  const content = `${JSON.stringify(record, null, 2)}\n`;
  const sha256 = hash(content);
  const path = `${statePath()}/blocker-context/${record.task_id}/${sha256.slice(7)}.json`;
  let existing;
  try { existing = await files.readFile({ path }); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing !== undefined && existing !== content) throw new Error("Immutable blocker context conflicts with its checksum.");
  if (existing === undefined) {
    try { await files.atomicWrite({ path, content, replace: false }); }
    catch (error) {
      if (!["FILE_ALREADY_EXISTS", "EEXIST"].includes(error.code)) throw error;
      if (await files.readFile({ path }) !== content) throw new Error("Immutable blocker context conflicts with its checksum.");
    }
  }
  return { section: record.section, part: record.part, total_parts: record.total_parts, path, sha256 };
}

// Gives existing recovery read tools a checksum-bound grant for one immutable context part from the current execution.
export function blockerPromptContextGrant(job, taskId, profile, path) {
  const ref = job?.prompt_context_refs?.find((entry) => entry.path === path);
  return ["sprint_leader", "architecture_manager", "coder"].includes(profile?.role) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(taskId ?? "")
    && job?.request?.task_id === taskId && job?.request?.project_id
    && /^sha256:[a-f0-9]{64}$/.test(ref?.sha256 ?? "")
    && path === `${statePath()}/blocker-context/${taskId}/${ref.sha256.slice(7)}.json` ? ref : null;
}

// Rejects replaced, cross-project or stale-assignment snapshot bytes without widening source or runtime permissions.
export function assertBlockerPromptContext(file, job, ref) {
  const record = JSON.parse(file.content);
  if (file.sha256 !== ref.sha256 || record.project_id !== job.request.project_id || record.task_id !== job.request.task_id
    || record.job_id !== job.id || record.execution_id !== (job.request.payload?.execution_id ?? null)
    || record.source_revision !== (job.request.execution_context?.source_revision ?? null)
    || record.section !== ref.section || record.part !== ref.part || record.total_parts !== ref.total_parts)
    throw Object.assign(new Error("Blocker context no longer matches the recovery assignment."), { code: "BLOCKER_CONTEXT_STALE" });
  return file;
}

// Re-arms a known terminal context failure once after the smaller prompt format is deployed, retaining the current consultation and Coder checkpoint.
export function createBlockerPromptRefresh({ inspect, clock = Date.now, projectLogger = () => {} }) {
  return async (job) => {
    if (job.outcome_reason !== "CONFIGURATION_ERROR" || !["sprint_leader", "architecture_manager"].includes(job.stage)
      || !/Claude Code returned an error result: Prompt is too long/.test(job.last_error ?? "")
      || job.prompt_context_version === 1 || job.stage === "architecture_manager" && job.resolution?.action !== "architecture_required") return false;
    if (!await inspect(job)) return false;
    job.prompt_context_version = 1;
    job.history.push({ stage: job.stage, event: "prompt_context_recovery_scheduled", completed_at: clock(), previous_error: job.last_error });
    delete job.validation_feedback;
    projectLogger({ event_name: "supervisor.blocker_prompt_context_recovery", level: "info", status: "pending", task_id: job.request.task_id,
      message: "Known terminal prompt overflow will retry once with compact context and read-only evidence references; original Coder checkpoint retained.", payload: { job_id: job.id, stage: job.stage } });
    return true;
  };
}
