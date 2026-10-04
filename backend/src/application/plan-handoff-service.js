// Hands an owner-approved architecture plan to Sprint Leader with a durable replay receipt.
import { ConfigurationError } from "../shared/errors.js";
import { assertMarkdownSprintScope, projectMarkdownSprintScope } from "../modules/governance/markdown-sprint-scope.js";

// Creates one handoff per approved plan revision while retaining generated drafts across retries.
export function createPlanHandoffService({ projectId, database, planStore, markdownPlanStore, sprintPlanLeader, sprintOrchestration, sprintRegistry, agentRoleResolver, clock = () => new Date().toISOString() } = {}) {
  if (!projectId || !database?.run || !database?.all || !database?.transaction || !planStore?.assertExecutable) throw new ConfigurationError("Plan handoff requires a project database and plan store.");
  const active = new Set();
  return Object.freeze({ handoff });

  // Rechecks approval, then reuses the indexed Sprint Leader result for repeat commands.
  async function handoff({ plan, conversationId }) {
    const markdown = plan.format === "markdown";
    const approved = markdown ? await markdownPlanStore.assertApproved({ planId: plan.plan_id, revision: plan.revision, sha256: plan.sha256 }) : await planStore.assertExecutable({ planId: plan.plan_id, revision: plan.revision, sha256: plan.sha256 });
    const table = markdown ? "markdown_plan_handoffs" : "plan_handoffs";
    if (approved.project_id !== projectId) throw fail("PROJECT_CONTEXT_CONFLICT", "Approved plan belongs to a different project.");
    if (typeof sprintPlanLeader?.requestPlan !== "function" || typeof sprintOrchestration?.ingestAgentCompletion !== "function") throw fail("SPRINT_LEADER_UNAVAILABLE", "Sprint Leader planning gateway is unavailable.");
    const key = `${approved.plan_id}:${approved.revision}`;
    if (active.has(key)) return { status: "handoff_in_progress", plan_handoff: true };
    const now = clock();
    database.transaction(() => database.run(`INSERT OR IGNORE INTO ${table}(plan_id,revision,project_id,sha256,status,updated_at) VALUES (?,?,?,?,?,?)`, [approved.plan_id, approved.revision, projectId, approved.sha256, "started", now]));
    let row = read(approved, table);
    if (row.project_id !== projectId || row.sha256 !== approved.sha256) throw fail("PLAN_HANDOFF_STALE", "Handoff receipt differs from the approved plan.");
    if (row.status === "completed" && (!markdown || roadmapHasSprint(database, row.sprint_id))) return { status: "handed_to_sprint_leader", sprint_id: row.sprint_id, plan_handoff: true, replayed: true };
    active.add(key);
    try {
      const correlationId = `CORR-PLAN-HANDOFF-${approved.plan_id}-${approved.revision}`;
      let generated = row.generated_json ? JSON.parse(row.generated_json) : null;
      if (!generated) {
        const profile = agentRoleResolver?.resolveProfile?.("sprint_leader");
        if (!profile?.agent_id) throw fail("SPRINT_LEADER_UNAVAILABLE", "Configured Sprint Leader profile is unavailable.");
        const brief = markdown ? `Approved plan_id=${approved.plan_id} revision=${approved.revision} sha256=${approved.sha256}\n\n${approved.markdown}` : JSON.stringify({ plan_id: approved.plan_id, revision: approved.revision, sha256: approved.sha256, content: approved.content });
        generated = await sprintPlanLeader.requestPlan({ projectId, agentId: profile.agent_id, brief, feedback: "Create the Sprint Plan from this owner-approved plan. For numbered work groups keep their order; for outcome rows decompose independently and map every outcome to tickets. Assign stable ticket IDs. Do not run tickets.", correlationId });
        if (!generated?.id || typeof generated.id !== "string") throw fail("SPRINT_PLAN_HANDOFF_FAILED", "Sprint Leader returned a plan without a sprint ID.");
        if (markdown) generated = projectMarkdownSprintScope(approved.markdown, generated);
      }
      if (markdown) generated = bindMarkdownSprintMetadata(generated, projectId, database);
      if (markdown) assertMarkdownSprintScope(approved.markdown, generated);
      if (generated.run === true || generated.status === "RUN") throw fail("SPRINT_PLAN_EXECUTION_FORBIDDEN", "Sprint handoff only admits a non-executing draft.");
      database.run(`UPDATE ${table} SET status=?,sprint_id=?,generated_json=?,error_code=NULL,error_message=NULL,updated_at=? WHERE plan_id=? AND revision=? AND sha256=?`, ["generated", generated.id, JSON.stringify(generated), clock(), approved.plan_id, approved.revision, approved.sha256]);
      row = read(approved, table);
      const existing = sprintRegistry?.get?.(generated.id);
      if (existing) {
        const child = await planStore.getRevision({ planId: existing.plan_id, revision: existing.plan_revision });
        if (child.proposal_id !== parentKey(approved)) throw fail("PLAN_HANDOFF_CONFLICT", "Sprint ID is already bound to another plan revision.");
      }
      if (!existing || markdown && !roadmapHasSprint(database, generated.id)) {
        const text = `\`\`\`json\n${JSON.stringify(generated)}\n\`\`\``;
        const ingested = await sprintOrchestration.ingestAgentCompletion({ message: { project_id: projectId, correlation_id: correlationId, conversation_id: conversationId ?? `CONV-PLAN-${approved.plan_id}`, approved_parent_plan_key: parentKey(approved) }, agentId: "sprint-leader", text });
        if (!ingested?.ingested) throw fail("SPRINT_PLAN_HANDOFF_FAILED", ingested?.error ?? "Sprint Leader plan ingestion failed.");
      }
      if (markdown && !roadmapHasSprint(database, generated.id)) throw fail("SPRINT_PLAN_HANDOFF_FAILED", "Sprint draft is registered but missing from the project roadmap.");
      database.run(`UPDATE ${table} SET status=?,sprint_id=?,error_code=NULL,error_message=NULL,updated_at=? WHERE plan_id=? AND revision=? AND sha256=?`, ["completed", generated.id, clock(), approved.plan_id, approved.revision, approved.sha256]);
      return { status: "handed_to_sprint_leader", sprint_id: generated.id, plan_handoff: true, text: `Sprint Leader đã tạo draft ${generated.id} từ kế hoạch Markdown đã duyệt. Chưa RUN.` };
    } catch (error) {
      database.run(`UPDATE ${table} SET error_code=?,error_message=?,updated_at=? WHERE plan_id=? AND revision=?`, [error.code ?? "PLAN_HANDOFF_FAILED", error.message, clock(), approved.plan_id, approved.revision]);
      throw error;
    } finally { active.delete(key); }
  }

  // Reads one durable handoff receipt under the approved plan identity.
  function read(plan, table) { return database.all(`SELECT * FROM ${table} WHERE plan_id=? AND revision=?`, [plan.plan_id, plan.revision])[0]; }
}

// Binds a child Sprint draft to the exact approved parent revision and checksum.
function parentKey(plan) { return `${plan.plan_id}-R${plan.revision}-${plan.sha256}`; }

// Confirms a Sprint is visible in the latest persisted project roadmap before completing handoff.
function roadmapHasSprint(database, sprintId) {
  const row = database.all("SELECT roadmap_json FROM governance_roadmaps ORDER BY sequence DESC LIMIT 1")[0];
  return Boolean(row && JSON.parse(row.roadmap_json).sprints?.some((sprint) => sprint.id === sprintId));
}

// Binds the draft to the active roadmap and converts cited observations into schema-safe references.
function bindMarkdownSprintMetadata(sprint, projectId, database) {
  const roadmapRow = database.all("SELECT roadmap_json FROM governance_roadmaps ORDER BY sequence DESC LIMIT 1")[0];
  const roadmap = roadmapRow ? JSON.parse(roadmapRow.roadmap_json) : null;
  if (!roadmap?.id || roadmap.project_id !== projectId) throw fail("SPRINT_ROADMAP_UNAVAILABLE", "The active project roadmap is unavailable for Sprint handoff.");
  if (sprint.roadmap_id && sprint.roadmap_id !== roadmap.id) throw fail("SPRINT_ROADMAP_CONFLICT", "Sprint Leader selected a different roadmap.");
  if (sprint.project_id && sprint.project_id !== projectId) throw fail("PROJECT_CONTEXT_CONFLICT", "Sprint Leader selected a different project.");
  const refs = sprint.human_plan?.evidence_refs;
  const evidenceRefs = Array.isArray(refs) ? refs.map((ref) => {
    if (typeof ref === "string") return ref;
    if (ref && typeof ref.reference === "string" && typeof ref.observation === "string") return `${ref.reference}: ${ref.observation}`;
    throw fail("SPRINT_EVIDENCE_INVALID", "Sprint Leader evidence references must be text or cited observations.");
  }) : refs;
  return { ...sprint, roadmap_id: roadmap.id, project_id: projectId, ...(sprint.human_plan ? { human_plan: { ...sprint.human_plan, evidence_refs: evidenceRefs } } : {}) };
}

// Produces a stable error for invalid or unavailable handoffs.
function fail(code, message) { return Object.assign(new ConfigurationError(message), { code, statusCode: 409 }); }
