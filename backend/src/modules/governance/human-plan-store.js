// Persists human-reviewed plans as immutable files with a SQLite integrity and decision index.
import { createHash, randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { acquireTicketFileLock } from "../supervisor/ticket-file-lock.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLAN_ROOT = ".forge/runtime/nf/plans";
const DECISIONS = new Set(["approved", "rejected", "changes_requested"]);
const hash = (text) => createHash("sha256").update(text).digest("hex");

// Gives plan integrity and approval failures stable codes for execution gates.
function fail(code, message) { return Object.assign(new ConfigurationError(message), { code, statusCode: 409 }); }

// Requires the concrete scope that a human must review before execution.
function validateContent(content) {
  const strings = ["objective", "outcome", "in_scope", "out_of_scope", "approach"];
  const lists = ["components", "tickets", "dependencies", "risks", "assumptions", "open_questions", "evidence_refs", "acceptance_criteria"];
  if (!content || typeof content !== "object" || Array.isArray(content)
    || strings.some((key) => typeof content[key] !== "string" || !content[key].trim())
    || lists.some((key) => !Array.isArray(content[key]) || content[key].some((item) => typeof item !== "string" || !item.trim()))
    || !content.components.length || !content.tickets.length || !content.evidence_refs.length || !content.acceptance_criteria.length) throw fail("PLAN_CONTENT_INVALID", "Plan draft requires scope, approach, components, ticket sequencing, evidence, risks, and acceptance criteria.");
}

// Creates the plan registry used to bind human approval to exact source bytes.
export function createHumanPlanStore({ projectId, database, fileService, markdownPlans, clock = () => new Date().toISOString() } = {}) {
  if (!projectId || !database?.all || !database?.run || !database?.transaction || !fileService?.readFile || !fileService?.atomicCreate || !fileService?.createLock) throw fail("PLAN_STORE_CONFIG", "Plan store requires project database and File Service.");
  return Object.freeze({ createRevision, getRevision, list, decide, approveDerived, assertExecutable });

  // Writes a new immutable revision before indexing it; an orphan file never grants execution.
  async function createRevision({ planId, sprintId = null, content, proposalId = null, expectedRevision, sourcePath = null, sourceSha256 = null } = {}) {
    if (!SAFE_ID.test(planId ?? "") || sprintId !== null && !SAFE_ID.test(sprintId) || proposalId !== null && !SAFE_ID.test(proposalId)) throw fail("PLAN_ID_INVALID", "Plan, sprint, and proposal identifiers must be safe.");
    content = stripCandidateMetadata(content);
    validateContent(content);
    const lock = await acquireTicketFileLock(fileService, `${PLAN_ROOT}/${planId}/revision.lock`);
    try {
      const head = database.all("SELECT revision FROM plan_heads WHERE plan_id=? AND project_id=?", [planId, projectId])[0];
      const current = head?.revision ?? 0;
      if (expectedRevision !== current) throw fail("PLAN_REVISION_CONFLICT", "Plan revision changed or expectedRevision was omitted.");
      const revision = current + 1;
      const filePath = `${PLAN_ROOT}/${planId}/${revision}.json`;
      const createdAt = clock();
      if (sourcePath !== null && (typeof sourcePath !== "string" || !sourcePath.trim())) throw fail("PLAN_SOURCE_INVALID", "Plan source path must be a non-empty relative path.");
      if (sourceSha256 !== null && !/^[a-f0-9]{64}$/.test(sourceSha256)) throw fail("PLAN_SOURCE_INVALID", "Plan source checksum must be a SHA-256 digest.");
      if (sourcePath !== null || sourceSha256 !== null) {
        if (!sourcePath || !sourceSha256) throw fail("PLAN_SOURCE_INVALID", "A source path and checksum must be supplied together.");
        let sourceBytes;
        try { sourceBytes = await fileService.readFile({ path: sourcePath }); }
        catch (error) { throw fail("PLAN_SOURCE_MISSING", `Plan source file is unavailable: ${error.code ?? error.message}.`); }
        if (hash(sourceBytes) !== sourceSha256) throw fail("PLAN_SOURCE_MISMATCH", "Plan source checksum does not match the source file.");
      }
      const artifact = { plan_id: planId, revision, project_id: projectId, sprint_id: sprintId, proposal_id: proposalId, created_at: createdAt, ...(sourcePath ? { source_path: sourcePath } : {}), ...(sourceSha256 ? { source_sha256: sourceSha256 } : {}), content: structuredClone(content) };
      const bytes = `${JSON.stringify(artifact)}\n`;
      await fileService.atomicCreate({ path: filePath, content: bytes });
      const sha256 = hash(bytes);
      database.transaction(() => {
        database.run("INSERT INTO plan_revisions(plan_id,revision,project_id,sprint_id,file_path,sha256,source_path,source_sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?)", [planId, revision, projectId, sprintId, filePath, sha256, sourcePath, sourceSha256, createdAt]);
        if (head) database.run("UPDATE plan_heads SET revision=? WHERE plan_id=? AND project_id=? AND revision=?", [revision, planId, projectId, current]);
        else database.run("INSERT INTO plan_heads(plan_id,project_id,revision) VALUES (?,?,?)", [planId, projectId, revision]);
      });
      return { ...artifact, file_path: filePath, sha256, status: "awaiting_human_approval" };
    } finally { await lock.release(); }
  }

  // Reads the indexed file and rejects missing, changed, or unindexed plan bytes.
  async function getRevision({ planId, revision } = {}) {
    if (!SAFE_ID.test(planId ?? "") || !Number.isSafeInteger(revision) || revision < 1) throw fail("PLAN_ID_INVALID", "Plan ID and positive revision are required.");
    const row = database.all("SELECT * FROM plan_revisions WHERE plan_id=? AND revision=? AND project_id=?", [planId, revision, projectId])[0];
    if (!row) throw fail("PLAN_REVISION_NOT_FOUND", "Plan revision is not indexed for this project.");
    let bytes;
    try { bytes = await fileService.readFile({ path: row.file_path }); }
    catch (error) { throw fail("PLAN_FILE_MISSING", `Indexed plan file is unavailable: ${error.code ?? error.message}.`); }
    if (hash(bytes) !== row.sha256) throw fail("PLAN_HASH_MISMATCH", "Plan file differs from its SQLite checksum.");
    let artifact;
    try { artifact = JSON.parse(bytes); }
    catch (error) { throw fail("PLAN_FILE_INVALID", `Indexed plan file is not JSON: ${error.message}.`); }
    if (artifact.plan_id !== planId || artifact.revision !== revision || artifact.project_id !== projectId || artifact.sprint_id !== row.sprint_id) throw fail("PLAN_IDENTITY_MISMATCH", "Plan file identity differs from its index.");
    const decision = database.all("SELECT * FROM plan_decisions WHERE plan_id=? AND revision=? ORDER BY decided_at DESC, rowid DESC LIMIT 1", [planId, revision])[0] ?? null;
    const head = database.all("SELECT revision FROM plan_heads WHERE plan_id=? AND project_id=?", [planId, projectId])[0];
    const derived = database.all("SELECT * FROM derived_plan_approvals WHERE plan_id=? AND revision=?", [planId, revision])[0] ?? null;
    const status = head?.revision !== revision ? "superseded" : decision?.decision ?? (derived ? "approved" : "awaiting_human_approval");
    if (row.source_path !== (artifact.source_path ?? null) || row.source_sha256 !== (artifact.source_sha256 ?? null)) throw fail("PLAN_SOURCE_MISMATCH", "Plan source binding differs from its SQLite index.");
    return { ...artifact, content: stripCandidateMetadata(artifact.content), file_path: row.file_path, sha256: row.sha256, source_path: row.source_path, source_sha256: row.source_sha256, status, decision, approval_basis: derived ? "approved_markdown_projection" : null };
  }

  // Lists plan heads without making roadmap JSON an authority for scheduling.
  function list() {
    return database.all("SELECT h.plan_id,h.revision,r.sprint_id,r.file_path,r.sha256,r.source_path,r.source_sha256,r.created_at FROM plan_heads h JOIN plan_revisions r ON r.plan_id=h.plan_id AND r.revision=h.revision WHERE h.project_id=? ORDER BY r.created_at", [projectId]);
  }

  // Records exactly one append-only human decision for the reviewed revision and hash.
  async function decide({ planId, revision, sha256, sourceSha256 = null, decision, approverId, actorRole, comments = null, decisionId = `PLAN-DECISION-${randomUUID()}` } = {}) {
    if (!SAFE_ID.test(planId ?? "") || !DECISIONS.has(decision) || !SAFE_ID.test(approverId ?? "") || actorRole !== "project_owner" || !SAFE_ID.test(decisionId) || typeof sha256 !== "string") throw fail("PLAN_DECISION_INVALID", "A project owner decision, approver, and plan checksum are required.");
    const lock = await acquireTicketFileLock(fileService, `${PLAN_ROOT}/${planId}/decision.lock`);
    try {
      const plan = await getRevision({ planId, revision });
      if (plan.approval_basis) throw fail("PLAN_DERIVED_APPROVAL", "A derived Sprint Plan cannot receive a separate owner decision.");
      if (plan.sha256 !== sha256) throw fail("PLAN_DECISION_STALE", "Human decision checksum differs from reviewed plan.");
      if (plan.source_sha256 !== sourceSha256) throw fail("PLAN_DECISION_STALE", "Human decision source checksum differs from reviewed plan.");
      if (plan.status === "superseded") throw fail("PLAN_DECISION_STALE", "A superseded revision cannot receive a new decision.");
      if (plan.decision) {
        const sameReplay = plan.decision.decision_id === decisionId
          && plan.decision.sha256 === sha256
          && plan.decision.source_sha256 === sourceSha256
          && plan.decision.decision === decision
          && plan.decision.approver_id === approverId;
        if (sameReplay) return plan.decision;
        throw fail("PLAN_DECISION_EXISTS", "Plan revision already has a human decision; create a new revision.");
      }
      const recorded = { decision_id: decisionId, plan_id: planId, revision, sha256, source_sha256: sourceSha256, decision, approver_id: approverId, comments, decided_at: clock() };
      database.run("INSERT INTO plan_decisions(decision_id,plan_id,revision,sha256,source_sha256,decision,approver_id,comments,decided_at) VALUES (?,?,?,?,?,?,?,?,?)", Object.values(recorded));
      return recorded;
    } finally { await lock.release(); }
  }

  // Records a JSON projection only after the exact Markdown source has owner approval.
  async function approveDerived({ planId, revision, sha256, markdownPlanId, markdownRevision, markdownSha256 } = {}) {
    if (!markdownPlans?.assertApproved) throw fail("PLAN_MARKDOWN_UNAVAILABLE", "Approved Markdown plan verification is unavailable.");
    const markdown = await markdownPlans.assertApproved({ planId: markdownPlanId, revision: markdownRevision, sha256: markdownSha256 });
    const plan = await getRevision({ planId, revision });
    if (plan.sha256 !== sha256 || plan.source_path !== markdown.file_path || plan.source_sha256 !== markdown.sha256 || plan.status === "superseded" || plan.decision) throw fail("PLAN_DERIVATION_MISMATCH", "Sprint Plan is not bound to the approved Markdown bytes.");
    const existing = database.all("SELECT * FROM derived_plan_approvals WHERE plan_id=? AND revision=?", [planId, revision])[0];
    if (existing) {
      if (existing.sha256 !== sha256 || existing.markdown_plan_id !== markdownPlanId || existing.markdown_revision !== markdownRevision || existing.markdown_sha256 !== markdownSha256 || existing.markdown_decision_id !== markdown.decision.decision_id) throw fail("PLAN_DERIVATION_MISMATCH", "Derived approval identity changed.");
      return plan;
    }
    database.run("INSERT INTO derived_plan_approvals(plan_id,revision,sha256,markdown_plan_id,markdown_revision,markdown_sha256,markdown_decision_id,created_at) VALUES (?,?,?,?,?,?,?,?)", [planId, revision, sha256, markdownPlanId, markdownRevision, markdownSha256, markdown.decision.decision_id, clock()]);
    return getRevision({ planId, revision });
  }

  // Resolves the current approved revision before any sprint or ticket execution.
  async function assertExecutable({ planId, revision, sha256 } = {}) {
    const plan = await getRevision({ planId, revision });
    if (plan.sha256 !== sha256 || plan.status !== "approved") throw fail("PLAN_APPROVAL_REQUIRED", "Execution requires the current, intact, human-approved plan revision.");
    if (plan.approval_basis) {
      const row = database.all("SELECT * FROM derived_plan_approvals WHERE plan_id=? AND revision=?", [planId, revision])[0];
      const markdown = await markdownPlans?.assertApproved?.({ planId: row?.markdown_plan_id, revision: row?.markdown_revision, sha256: row?.markdown_sha256 });
      if (!row || row.sha256 !== sha256 || markdown?.file_path !== plan.source_path || markdown?.sha256 !== plan.source_sha256 || markdown?.decision?.decision_id !== row.markdown_decision_id) throw fail("PLAN_APPROVAL_REQUIRED", "Derived approval no longer matches the reviewed Markdown.");
    } else if (plan.decision?.sha256 !== sha256) throw fail("PLAN_APPROVAL_REQUIRED", "Execution requires an exact owner decision.");
    return plan;
  }
}

// Removes obsolete file-discovery hints from plan projections while preserving immutable plan identity.
function stripCandidateMetadata(value) {
  if (Array.isArray(value)) return value.map(stripCandidateMetadata);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["candidate_files", "candidates_produced_by", "candidates_produced_at"].includes(key))
    .map(([key, entry]) => [key, stripCandidateMetadata(entry)]));
}
