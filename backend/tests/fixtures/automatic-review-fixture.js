// Models durable review delivery and verified Coder revisions without starting real provider sessions.
import { createAutomaticTicketReview } from "../../src/modules/supervisor/automatic-ticket-review.js";
import { completeCoderTicket } from "../../src/modules/supervisor/ticket-coder-completion.js";

// Builds an isolated ticket pipeline with restartable stores and explicit integration witnesses.
export function automaticReviewFixture({ gate = "on", limit = 2, review, publicationFailure } = {}) {
  const records = new Map();
  const events = [];
  const order = [];
  const seenEvents = new Set();
  let revision = 1;
  let calls = 0;
  let integrations = 0;
  let open = [];
  let context;
  let artifact;
  let rules = "Reviewer must read exact evidence and never auto-approve.";
  const request = { task_id: "TICKET-1", project_id: "PROJECT-1", supervisor_id: "SUP-1", request_id: "REQ-1", correlation_id: "CORR-1", agent_id: "coder-1", attempt: 1,
    ticket: { id: "TICKET-1", title: "Repair a verified ticket", acceptance_criteria: ["Correct result"], execution_policy: { review_gate: gate, max_review_revisions: limit } }, payload: {} };
  const queueStore = {
    list: async (name) => structuredClone(records.get(name) ?? []),
    save: async (name, job) => { const entries = records.get(name) ?? []; const position = entries.findIndex((entry) => entry.id === job.id); if (position < 0) entries.push(structuredClone(job)); else entries[position] = structuredClone(job); records.set(name, entries); return job; }
  };
  const queue = {
    enqueue: async (job) => { order.push("enqueue"); return (await queueStore.list("agent.request")).find((entry) => entry.request_id === job.request_id); },
    ack: async (id) => { const job = (await queueStore.list("agent.request")).find((entry) => entry.id === id); await queueStore.save("agent.request", { ...job, status: "completed" }); order.push("ack"); }
  };
  const eventBus = { publish: async (event) => {
    if (publicationFailure?.(event)) throw new Error("Event transport interrupted");
    if (event.event_id && seenEvents.has(event.event_id)) return;
    if (event.event_id) seenEvents.add(event.event_id);
    events.push(structuredClone(event)); order.push(event.type);
  } };
  const workspace = {
    executionContexts: { load: async () => structuredClone(context), create: async () => context, syncManifest: async () => context, update: async (taskId, version, patch) => { context = { ...context, ...patch, version: version + 1 }; } },
    testService: { assertPassedArtifact: async () => { order.push("artifact"); return structuredClone(artifact); } },
    reportService: { assertCoderReport: async () => { order.push("report"); }, completeCoderReport: async () => { order.push("coder_report_completed"); }, completeAcceptedReport: async () => { order.push("approved_report_completed"); } },
    changeLedger: { snapshot: async () => ({ revision, entries: {}, commits: {} }), release: async () => { order.push("ledger_release"); } },
    integrate: async () => { integrations += 1; order.push("integrate"); },
    reviewFindings: {
      load: async () => ({ findings: structuredClone(open), coder_reports: [{ artifact_id: artifact.artifact_id, report: { summary: "Coder explained the result" } }] }),
      recordReview: async (payload) => {
        order.push("findings");
        for (const finding of payload.findings ?? []) open.push({ ...finding, finding_id: `REV-${open.length + 1}` });
        for (const decision of payload.adjudications ?? []) if (["fixed", "withdraw", "not_applicable"].includes(decision.decision)) open = open.filter((finding) => finding.finding_id !== decision.finding_id);
        if (payload.verdict === "approved" && open.length) throw Object.assign(new Error("Retained finding remains open"), { code: "REVIEW_FINDINGS_UNRESOLVED" });
      },
      unresolved: async () => structuredClone(open),
      assertResolved: async () => { if (open.length) throw Object.assign(new Error("Retained finding remains open"), { code: "REVIEW_FINDINGS_UNRESOLVED" }); }
    }
  };
  const fileService = { readForIndex: async () => ({ content: rules }) };
  const options = { queueStore, queue, eventBus, fileService, resolveTicketWorkspace: async () => workspace,
    resolveWorker: async () => ({ review: async (job) => {
      calls += 1; order.push("review");
      const result = review ? await review(job, calls) : { verdict: "approved", findings: [], adjudications: [] };
      return { reviewer_id: "reviewer-1", source_revision: job.decision_identity.source_revision, ...result };
    } }) };
  let service = createAutomaticTicketReview(options);
  revise();
  return { request, workspace, queueStore, records, events, order, fileService, eventBus,
    get service() { return service; }, get artifact() { return artifact; }, get calls() { return calls; }, get integrations() { return integrations; },
    revise, restart: () => { service = createAutomaticTicketReview(options); return service; }, setRules: (value) => { rules = value; },
    prepare: (inline = true) => service.prepare({ request, artifact, workspace, inline }),
    complete: (runRepair) => completeCoderTicket({ request, workspace, taskId: request.task_id, ownerId: request.supervisor_id, claim: { claim_id: "CODER-CLAIM" },
      agentOccupancy: { release: async () => { order.push("coder_release"); } }, automaticReview: service, runRepair,
      result: { summary: "Coder reported", tool_events: [{ name: "report_done", status: "success" }] },
      publishTicketOutcome: (type, current, owner, payload) => eventBus.publish({ type, event_id: payload.event_id, task_id: current.task_id, supervisor_id: owner, request_id: current.request_id, correlation_id: current.correlation_id, payload }) }) };

  // Advances verified source identity when the Coder reports a genuinely repaired commit.
  function revise() {
    artifact = { status: "passed", artifact_id: `ARTIFACT-${revision}`, source_revision: revision, commit_sha: String(revision).repeat(40), base_sha: "a".repeat(40), manifest_sha: `sha256:manifest-${revision}`,
      file_checksums: { "backend/src/sample.js": `sha256:content-${revision}` }, changed_paths: ["backend/src/sample.js"] };
    context = { task_id: request.task_id, state: "verified", version: revision, source_revision: revision, review_commit_sha: artifact.commit_sha, base_sha: artifact.base_sha,
      manifest_sha: artifact.manifest_sha, manifest_paths: artifact.changed_paths, verification_artifact_id: artifact.artifact_id };
    revision += 1;
  }
}
