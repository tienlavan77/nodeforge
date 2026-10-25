/** Verifies independent evidence reads use immutable source and recorded
 * artifacts through the same provider-neutral Forge readers, with bounded
 * output and no write, test, approval or formal review capabilities. */
import assert from "node:assert/strict";
import test from "node:test";
import { createBlockerReviewerTools } from "../../src/modules/supervisor/blocker-reviewer-tools.js";
import { createBlockerRecoveryAgent } from "../../src/modules/supervisor/blocker-recovery-agent.js";
import { blockerExchangePrompt } from "../../src/modules/supervisor/blocker-exchange-prompt.js";
import { blockerReviewerExchange } from "../../src/modules/supervisor/blocker-reviewer-evidence.js";
import { blockerReviewerEvidenceFixture } from "../fixtures/blocker-reviewer-evidence-fixture.js";
import { createAgentExchangeOutput } from "../../src/modules/governance/agent-exchange-output.js";

test("Reviewer tools read and search pinned source despite workspace changes and page a 151KB artifact", async () => {
  const f = await blockerReviewerEvidenceFixture();
  try {
    await f.base.fileService.atomicWrite({ path: f.artifactPath, content: JSON.stringify({ ...f.artifact,
      output: Array.from({ length: 500 }, (_, index) => `line-${index}: ${"x".repeat(300)}`) }), replace: true });
    const job = await f.assignedJob();
    await f.base.fileService.atomicWrite({ path: f.evidence.path, content: "export const unrelatedWorkspaceChange = true;\n", replace: true });
    await f.base.fileService.atomicWrite({ path: "backend/src/untracked.js", content: "export const untracked = true;\n", replace: true });
    const saved = [];
    const tools = await createBlockerReviewerTools({ projectRoot: f.projectRoot, fileService: f.base.fileService, job,
      profile: { role: "reviewer", agent_id: "RV" }, onDiscoveryCheckpoint: async (value) => saved.push(value) });
    assert.deepEqual(tools.definitions.map((entry) => entry.name).sort(), ["git_diff", "git_status", "list_files", "read_file", "read_lines", "search_text", "search_tree"]);
    const source = await tools.registry.read_file.execute({ path: f.evidence.path, offset: 1, limit: 80 });
    assert.equal(source.sha256, `sha256:${f.evidence.sha256}`);
    assert.match(source.content, /approvedHandler/);
    assert.doesNotMatch(source.content, /unrelatedWorkspaceChange/);
    const search = await tools.registry.search_text.execute({ pattern: "approvedHandler", paths: ["backend/src"], flags: ["-n"] });
    assert.match(search.stdout, /approvedHandler/);
    const listed = await tools.registry.list_files.execute({});
    assert.doesNotMatch(listed.stdout, /untracked.js/);
    const diff = await tools.registry.git_diff.execute({});
    assert.equal(diff.stdout, "");
    assert.equal(diff.source_commit_sha, f.subject.commit_sha);
    const status = await tools.registry.git_status.execute({});
    assert.equal(status.scope, "workspace_observation_only");
    assert.equal(status.working_tree, "dirty");
    const receipt = await tools.registry.read_file.execute({ path: f.artifactPath, offset: 1, limit: 20 });
    assert(receipt.size_bytes > 151_000);
    assert(receipt.content.length <= 8000);
    assert(receipt.truncated);
    assert.equal(receipt.view_format, "formatted_json");
    const last = await tools.registry.read_lines.execute({ path: f.artifactPath, start_line: 500, end_line: 510 });
    assert(last.stdout.length <= 8000);
    assert.match(last.stdout, /line-48/);
    assert.equal(last.sha256, job.ticket_progress.verification.receipt_index[0].receipt_sha256);
    assert(saved.length >= 6);
    await f.base.fileService.atomicWrite({ path: f.artifactPath, content: JSON.stringify({ ...f.artifact, status: "passed" }), replace: true });
    await assert.rejects(tools.registry.read_file.execute({ path: f.artifactPath }), { code: "VERIFY_SOURCE_STALE" });
  } finally { await f.close(); }
});

test("Reviewer receives exact response correction feedback without unrelated Coder instructions", async () => {
  const f = await blockerReviewerEvidenceFixture();
  try {
    const job = await f.assignedJob();
    job.validation_feedback = [{ path: "/payload/subject", reason: "subject_mismatch", message: "Preserve the assigned artifact." }];
    const prompt = blockerExchangePrompt({ request: blockerReviewerExchange(job, { agent_id: "RV" }), job,
      tools: { definitions: [] }, context: { summary: "Use the assigned evidence only." } });
    assert.match(prompt, /REVIEW RESPONSE CORRECTION/);
    assert.match(prompt, /subject_mismatch/);
    assert.match(prompt, /Preserve the assigned artifact/);
    assert.doesNotMatch(prompt, /Coder returns work_result/);
  } finally { await f.close(); }
});

test("Codex and Claude receive the same evidence-only review contract and return reports directly to AM", async () => {
  for (const provider of ["codex", "anthropic"]) {
    const f = await blockerReviewerEvidenceFixture();
    try {
      const job = await f.assignedJob(), communication = [];
      const profile = { agent_id: "RV", role: "reviewer", provider, enabled: true, status: "ready" };
      let released = 0;
      const worker = createBlockerRecoveryAgent({ agentResolver: { resolveAvailable: () => profile }, resolveTicketWorkspace: async () => f.base.workspace,
        agentOccupancy: { claim: async () => ({ claim_id: "RV-CLAIM" }), release: async () => { released += 1; } },
        gateways: { [provider === "codex" ? "codexSdkGateway" : "claudeSdkGateway"]: { execute: async (input) => {
          const expected = createAgentExchangeOutput(blockerReviewerExchange(job, profile)).schema;
          if (provider === "codex") assert.deepEqual(input.options.outputSchema, expected);
          else {
            assert.deepEqual(input.options.outputFormat, { type: "json_schema", schema: expected });
            assert.deepEqual(input.options.tools, []);
          }
          assert.match(input.prompt, /INDEPENDENT BLOCKER EVIDENCE/);
          assert.match(input.prompt, /"kind":"review_request"/);
          assert.match(input.prompt, /"role":"architecture_manager"/);
          assert.match(input.prompt, /purpose=blocker_evidence/);
          assert.doesNotMatch(input.prompt, /AM ROLE CONTRACT/);
          assert.doesNotMatch(input.prompt, /Coder returns work_result/);
          return { text: JSON.stringify({ kind: "review_result", subject: "Committed handler inspected.", evidence: [
            { type: "source", ref: f.evidence.path, sha256: f.evidence.sha256, purpose: "Committed checksum comparison." } ], payload: {
            purpose: "blocker_evidence", subject: f.subject, summary: "Committed checksum recorded.", outcome: "completed",
            observations: ["Handler matches the commit."], missing_evidence: [], findings: [], finding_updates: [] } }) };
        } } } });
      const result = await worker(job, { deadline: Date.now() + 10_000, onCommunication: async (value) => communication.push(value) });
      assert.equal(result.action, "review_evidence_provided");
      assert.equal(result.review_evidence.subject.commit_sha, f.subject.commit_sha);
      assert.equal(released, 1);
      assert(communication.some((entry) => entry.response_ref?.ref));
    } finally { await f.close(); }
  }
});
