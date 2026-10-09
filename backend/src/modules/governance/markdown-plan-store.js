// Keeps the owner's readable plan and exact approval immutable before Sprint Leader drafting.
import { createHash, randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { acquireTicketFileLock } from "../supervisor/ticket-file-lock.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DECISIONS = new Set(["approved", "rejected", "changes_requested"]);
const sha = (value) => createHash("sha256").update(value).digest("hex");

// Gives readable plan integrity failures stable governance codes.
function fail(code, message) { return Object.assign(new ConfigurationError(message), { code, statusCode: 409 }); }

// Persists readable plan revisions and append-only owner decisions for one project.
export function createMarkdownPlanStore({ projectId, database, fileService, clock = () => new Date().toISOString() } = {}) {
  if (!projectId || !database?.all || !database?.run || !fileService?.readFile || !fileService?.atomicCreate || !fileService?.createLock) throw fail("MARKDOWN_PLAN_STORE_CONFIG", "Markdown plan store requires project database and File Service.");
  return Object.freeze({ createRevision, getRevision, list, decide, assertApproved });

  // Indexes the exact Markdown bytes and source SUMMARY before they can be reviewed.
  async function createRevision({ planId, expectedRevision = 0, markdown, summaryPath, summarySha256, conversationId = null } = {}) {
    if (!SAFE_ID.test(planId ?? "") || typeof markdown !== "string" || !markdown.trim() || !summaryPath || !/^[a-f0-9]{64}$/.test(summarySha256 ?? "")) throw fail("MARKDOWN_PLAN_INVALID", "Plan ID, Markdown, and SUMMARY checksum are required.");
    const lock = await acquireTicketFileLock(fileService, `.forge/runtime/nf/plans/${planId}/markdown.lock`);
    try {
      const current = database.all("SELECT MAX(revision) AS revision FROM markdown_plan_revisions WHERE plan_id=? AND project_id=?", [planId, projectId])[0]?.revision ?? 0;
      if (current !== expectedRevision) throw fail("PLAN_REVISION_CONFLICT", "Markdown plan revision changed.");
      let summary;
      try { summary = await fileService.readFile({ path: summaryPath }); }
      catch (error) { throw fail("PLAN_SOURCE_MISSING", `SUMMARY is unavailable: ${error.code ?? error.message}.`); }
      if (sha(summary) !== summarySha256) throw fail("PLAN_SOURCE_MISMATCH", "SUMMARY changed before plan persistence.");
      const revision = current + 1;
      const filePath = `.forge/runtime/nf/plans/${planId}/ke-hoach-r${revision}.md`;
      const bytes = `${markdown.trim()}\n`;
      await fileService.atomicCreate({ path: filePath, content: bytes });
      const digest = sha(bytes);
      const createdAt = clock();
      database.run("INSERT INTO markdown_plan_revisions(plan_id,revision,project_id,file_path,sha256,summary_path,summary_sha256,created_at,conversation_id) VALUES (?,?,?,?,?,?,?,?,?)", [planId, revision, projectId, filePath, digest, summaryPath, summarySha256, createdAt, conversationId]);
      return { plan_id: planId, revision, project_id: projectId, file_path: filePath, sha256: digest, source_path: summaryPath, source_sha256: summarySha256, conversation_id: conversationId, created_at: createdAt, format: "markdown", markdown: bytes, status: "awaiting_human_approval" };
    } finally { await lock.release(); }
  }

  // Reads only indexed, unmodified Markdown and its latest decision.
  async function getRevision({ planId, revision } = {}) {
    if (!SAFE_ID.test(planId ?? "") || !Number.isSafeInteger(revision) || revision < 1) throw fail("PLAN_ID_INVALID", "Plan ID and positive revision are required.");
    const row = database.all("SELECT * FROM markdown_plan_revisions WHERE plan_id=? AND revision=? AND project_id=?", [planId, revision, projectId])[0];
    if (!row) throw fail("PLAN_REVISION_NOT_FOUND", "Markdown plan revision is not indexed for this project.");
    let markdown;
    try { markdown = await fileService.readFile({ path: row.file_path }); }
    catch (error) { throw fail("PLAN_FILE_MISSING", `Markdown plan is unavailable: ${error.code ?? error.message}.`); }
    if (sha(markdown) !== row.sha256) throw fail("PLAN_HASH_MISMATCH", "Markdown plan differs from the reviewed checksum.");
    const latest = database.all("SELECT MAX(revision) AS revision FROM markdown_plan_revisions WHERE plan_id=? AND project_id=?", [planId, projectId])[0]?.revision;
    const decision = database.all("SELECT * FROM markdown_plan_decisions WHERE plan_id=? AND revision=? ORDER BY decided_at DESC, rowid DESC LIMIT 1", [planId, revision])[0] ?? null;
    const handoff = database.all("SELECT status,sprint_id FROM markdown_plan_handoffs WHERE plan_id=? AND revision=?", [planId, revision])[0] ?? null;
    const registered = handoff?.sprint_id && database.all("SELECT s.sprint_id FROM sprint_registry s JOIN plan_revisions p ON p.plan_id=s.plan_id AND p.revision=s.plan_revision AND p.project_id=s.project_id AND p.sprint_id=s.sprint_id AND p.sha256=s.plan_sha256 AND p.file_path=s.plan_path WHERE s.project_id=? AND s.sprint_id=? AND NOT EXISTS (SELECT 1 FROM sprint_registry_archives a WHERE a.project_id=s.project_id AND a.sprint_id=s.sprint_id)", [projectId, handoff.sprint_id]).length > 0;
    const handoffStatus = handoff?.status === "completed" && !registered ? "recovery_required" : handoff?.status ?? null;
    return { plan_id: planId, revision, project_id: projectId, file_path: row.file_path, sha256: row.sha256, source_path: row.summary_path, source_sha256: row.summary_sha256, conversation_id: row.conversation_id, created_at: row.created_at, format: "markdown", markdown, status: latest !== revision ? "superseded" : decision?.decision ?? "awaiting_human_approval", decision, handoff_status: handoffStatus, sprint_id: handoff?.sprint_id ?? null };
  }

  // Lists current readable drafts without presenting them as executable JSON plans.
  function list() {
    return database.all("SELECT r.plan_id,r.revision,r.project_id,r.file_path,r.sha256,r.summary_path AS source_path,r.summary_sha256 AS source_sha256,r.conversation_id,r.created_at FROM markdown_plan_revisions r WHERE r.project_id=? AND r.revision=(SELECT MAX(revision) FROM markdown_plan_revisions WHERE plan_id=r.plan_id AND project_id=r.project_id) ORDER BY r.created_at", [projectId]).map((row) => ({ ...row, format: "markdown", sprint_id: null }));
  }

  // Records the owner's decision for the exact bytes displayed in the UI.
  async function decide({ planId, revision, sha256, decision, approverId, comments = null, decisionId = `MARKDOWN-DECISION-${randomUUID()}` } = {}) {
    if (!DECISIONS.has(decision) || !SAFE_ID.test(approverId ?? "") || !SAFE_ID.test(decisionId)) throw fail("PLAN_DECISION_INVALID", "A valid owner decision is required.");
    const lock = await acquireTicketFileLock(fileService, `.forge/runtime/nf/plans/${planId}/markdown-decision.lock`);
    try {
      const plan = await getRevision({ planId, revision });
      if (plan.sha256 !== sha256 || plan.status === "superseded") throw fail("PLAN_DECISION_STALE", "Markdown plan identity changed.");
      if (plan.decision) {
        if (plan.decision.decision_id === decisionId && plan.decision.sha256 === sha256 && plan.decision.decision === decision) return plan.decision;
        throw fail("PLAN_DECISION_EXISTS", "Markdown revision already has an owner decision.");
      }
      const recorded = { decision_id: decisionId, plan_id: planId, revision, sha256, decision, approver_id: approverId, comments, decided_at: clock() };
      database.run("INSERT INTO markdown_plan_decisions(decision_id,plan_id,revision,sha256,decision,approver_id,comments,decided_at) VALUES (?,?,?,?,?,?,?,?)", Object.values(recorded));
      return recorded;
    } finally { await lock.release(); }
  }

  // Authorizes planning handoff only from an intact, approved Markdown revision.
  async function assertApproved({ planId, revision, sha256 } = {}) {
    const plan = await getRevision({ planId, revision });
    if (plan.sha256 !== sha256 || plan.status !== "approved" || plan.decision?.sha256 !== sha256) throw fail("PLAN_APPROVAL_REQUIRED", "Markdown plan requires exact owner approval before Sprint Leader handoff.");
    let source;
    try { source = await fileService.readFile({ path: plan.source_path }); }
    catch (error) { throw fail("PLAN_SOURCE_MISSING", `Approved SUMMARY is unavailable: ${error.code ?? error.message}.`); }
    if (sha(source) !== plan.source_sha256) throw fail("PLAN_SOURCE_MISMATCH", "Approved Markdown no longer matches its SUMMARY source.");
    return plan;
  }
}
