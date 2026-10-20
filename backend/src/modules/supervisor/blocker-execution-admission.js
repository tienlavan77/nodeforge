// Binds execution-denial review to original tool receipts, source contents and the retained ticket execution.
import { isBlockerApprovalDenial } from "./blocker-approval-denial.js";
import { createHash, randomUUID } from "node:crypto";
import { createBlockerFailureEvidence } from "./blocker-failure-evidence.js";
import { requiresBlockerAdmission } from "./blocker-failure-classification.js";
import { blockerValidationError } from "./blocker-validation.js";

const STORE = "blocker.recovery";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => hash(JSON.stringify(value));

// Returns explicit admission failures without treating an agent's technical opinion as permission.
export function admissionError(message, code = "EXECUTION_ADMISSION_REQUIRED", statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

// Reuses original failure evidence and approved source services to prepare an actionable owner review.
export function createBlockerAdmission({ store, inspect, clock = Date.now, projectLogger = () => {}, readFailureEvidence = createBlockerFailureEvidence({ toolNames: null, requirePath: false }) }) {
  return Object.freeze({ prepare, assertAllowed, access });

  // Captures the denial verbatim and binds its review to the exact current source and ticket authority.
  async function prepare(value, job) {
    if (value.action !== "reconciliation_required" || value.reconciliation?.kind !== "execution_admission") return value;
    if (job.reason_code === "ACCESS_REQUIRED" && !requiresBlockerAdmission(job)) {
      throw blockerValidationError("/reconciliation/kind", "execution_admission_misclassified",
        "Node's original execution-bound receipts identify technical failures, not an approval denial. Use tooling or source_revision reconciliation and consume Node ticket_progress.verification diagnostics. SL coordinates in-scope recovery; normal tool approval gates remain enforced.");
    }
    const authority = await inspect(job);
    if (!authority) throw admissionError("Ticket authority changed before preparing admission review.");
    const evidence = await readFailureEvidence(job, authority.workspace.projectRoot ?? authority.workspace.path);
    const receipts = evidence.receipts.filter(isBlockerApprovalDenial);
    if (!receipts.length && evidence.status === "captured" && evidence.receipts.some((entry) => entry.error?.code === "TICKET_BASELINE_CONFLICT")) {
      throw blockerValidationError("/reconciliation/kind", "execution_admission_misclassified",
        "The original operation failed with TICKET_BASELINE_CONFLICT, not an approval denial. Use source_revision reconciliation and inspect the commit receipt and ticket journal. Do not ask for owner permission or approval-provider recovery, and do not rewrite journal provenance or immutable plan bindings.");
    }
    if (!receipts.length) throw blockerValidationError("/reconciliation/kind", "execution_admission_unsubstantiated",
      "No original tool receipt establishes an approval denial. ACCESS_REQUIRED, PATH_FORBIDDEN and missing evidence are not approval decisions. Use tooling/source_revision reconciliation for the actual failure, or identify the missing receipt and its source without claiming a denial or granting permission. SL must choose the next concrete recovery step; preserve real tool gates and Reviewer adjudication.");
    if (evidence.status !== "captured") throw admissionError("Original approval denial receipts are incomplete; admission review cannot be prepared.", "EXECUTION_ADMISSION_EVIDENCE_REQUIRED");
    const paths = [...new Set([...receipts.map((entry) => entry.arguments?.path).filter((path) => typeof path === "string"), ...(value.evidence ?? []).map((entry) => entry.path)])].sort();
    const source = await sourceBinding(paths, authority);
    const binding = { project_id: job.request.project_id, task_id: job.request.task_id, execution_id: job.request.payload.execution_id,
      job_id: job.id, failure_at: job.failure_at, execution_context: job.request.execution_context,
      sprint_basis: job.request.payload.sprint_basis, architecture_basis: job.architecture_basis ?? null,
      receipts, source, technical_evidence: value.evidence ?? [], findings: value.reconciliation.completed_checks, proposed_guidance: value.guidance };
    const request = { ...binding, sha256: digest(binding), status: "awaiting_owner_review", created_at: clock(),
      endpoint: `/forge/v1/tickets/${encodeURIComponent(job.request.task_id)}/blocker-admission?project=${encodeURIComponent(job.request.project_id)}` };
    return { ...value, execution_admission_request: request };
  }

  // Rejects stale source before review or resume; the decision never changes plan or tool permissions.
  async function assertAllowed(job) {
    const admission = job.execution_admission;
    if (!admission) {
      if (job.technical_reconciliation?.work?.kind === "execution_admission") throw admissionError("Original denial must be bound to an owner review before resuming.");
      return;
    }
    if (admission.decision?.verdict !== "allow") throw admissionError("Execution denial awaits an authenticated owner review; RUN cannot repeat discovery to clear it.");
    const authority = await inspect(job);
    if (!authority) throw admissionError("Ticket authority changed after admission review.");
    const source = await sourceBinding(admission.source.map((entry) => entry.path), authority);
    if (digest(source) !== digest(admission.source)) throw admissionError("Source changed after admission review; prepare a new review before continuing.", "EXECUTION_ADMISSION_SOURCE_CHANGED");
  }

  // Reads or records an authenticated owner's exact decision without launching Coder or replaying the denied tool.
  async function access({ projectId, ticketId, actor, admission: input }) {
    if (typeof actor !== "string" || !actor.trim()) throw admissionError("Authenticated owner is required.", "EXECUTION_ADMISSION_UNAUTHORIZED", 403);
    const result = await store.withLock(STORE, async () => {
      const ledgers = (await store.list(STORE)).filter((entry) => entry.project_id === projectId && entry.task_id === ticketId && !entry.cancelled);
      let ledger;
      for (const candidate of ledgers.toReversed()) {
        if (candidate.jobs.at(-1) && await inspect(candidate.jobs.at(-1))) { ledger = candidate; break; }
      }
      const job = ledger?.jobs.at(-1);
      if (!job || !await inspect(job)) throw admissionError("No current execution admission request exists.");
      if (!job.execution_admission && job.resolution?.reconciliation?.kind === "execution_admission") {
        job.execution_admission = (await prepare(job.resolution, job)).execution_admission_request;
        await store.save(STORE, ledger);
      }
      let request = job.execution_admission;
      if (!request) throw admissionError("This blocker has no execution approval denial to review.");
      const authority = await inspect(job);
      const source = await sourceBinding(request.source.map((entry) => entry.path), authority);
      if (digest(source) !== digest(request.source)) {
        job.history.push({ stage: "sprint_leader", event: "execution_admission_source_changed", previous_request: request, completed_at: clock() });
        request = (await prepare(job.resolution, job)).execution_admission_request;
        job.execution_admission = request;
        await store.save(STORE, ledger);
        return { source_changed: input.method !== "GET", ticket_id: ticketId, execution_admission: request };
      }
      if (input.method === "GET") return { ticket_id: ticketId, execution_admission: request };
      const review = input.review;
      if (!review || !["allow", "deny"].includes(review.verdict) || typeof review.reason !== "string" || !review.reason.trim() || review.reason.length > 8000
        || review.verdict === "allow" && (typeof review.guidance !== "string" || !review.guidance.trim() || review.guidance.length > 8000)) throw admissionError("Supply verdict, reason and explicit permitted guidance for allow.", "EXECUTION_ADMISSION_INPUT", 400);
      if (review.request_sha256 !== request.sha256) throw admissionError("Admission request identity differs from the reviewed request.", "EXECUTION_ADMISSION_IDENTITY_MISMATCH");
      if (request.decision) {
        if (request.decision.verdict === review.verdict && request.decision.reason === review.reason && request.decision.guidance === (review.guidance ?? null)
          && request.decision.actor === actor) return { ticket_id: ticketId, execution_admission: request };
        throw admissionError("This admission request already has an immutable decision.", "EXECUTION_ADMISSION_DECISION_CONFLICT");
      }
      if (job.status !== "reconciliation_required") throw admissionError("Wait for the retained admission notification before reviewing.");
      request.decision = { decision_id: `ADMISSION-${randomUUID()}`, actor, verdict: review.verdict, reason: review.reason,
        guidance: review.guidance ?? null, request_sha256: request.sha256, decided_at: clock() };
      request.status = review.verdict === "allow" ? "owner_allowed" : "owner_denied";
      job.history.push({ stage: "sprint_leader", event: "execution_admission_reviewed", decision: request.decision, completed_at: clock() });
      await store.save(STORE, ledger);
      return { ticket_id: ticketId, execution_admission: request };
    });
    projectLogger({ event_name: "ticket.blocker_execution_admission", level: "info", status: "blocked", task_id: ticketId,
      message: "Optional execution review evidence retained; no agent launched. RUN returns to SL at the retained checkpoint without requiring this review.",
      payload: { request_sha256: result.execution_admission.sha256, decision: result.execution_admission.decision ?? null } });
    if (result.source_changed) throw admissionError("Source changed; a new review request was persisted. Read and review its new SHA.", "EXECUTION_ADMISSION_SOURCE_CHANGED");
    return result;
  }
}

// Uses the execution's file service so review cannot bind an unrelated runtime or bypass path policy.
async function sourceBinding(paths, authority) {
  const workspace = authority.workspace;
  const files = workspace.root_only ? workspace.fileService : workspace.worktreeFileService ?? workspace.fileService;
  return Promise.all(paths.map(async (path) => {
    try { return { path, sha256: hash(await files.readFile({ path })) }; }
    catch (error) {
      if (!["ENOENT", "FILE_NOT_FOUND"].includes(error.code)) throw error;
      return { path, sha256: null };
    }
  }));
}

// Keeps the trusted receipt visible to both SL and the resumed Coder while retaining tool-level checks.
export function admissionPrompt(admission) {
  return admission ? `NODE EXECUTION ADMISSION REVIEW: ${JSON.stringify(admission)}. This is optional historical review evidence, not a mandatory Owner gate for resuming SL and not tool permission. SL must identify a materially safer permitted alternative or a concrete remaining blocker; never retry a denied operation by relabeling or relocating it. Actual tool approval, source, claim and verification gates still run. No runtime acceptance is granted.` : "";
}
