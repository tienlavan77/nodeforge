// Verifies mandatory parent subagent discovery policy, controlled exceptions, provenance and relevance receipts, and compact token-saving evidence snapshots.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDelegatedDiscoveryRequired,
  recordDelegationReceipt,
  validateDelegationReceipt,
  isMeaningfulDelegationObjective
} from "../../src/tools/discovery/delegated-discovery-policy.js";
import { createDelegateSubagentTool } from "../../src/tools/discovery/delegate-subagent-tool.js";
import { createSubagentEvidenceStore } from "../../src/tools/discovery/subagent-evidence-store.js";
import { createSubagentEvidenceTool } from "../../src/tools/discovery/subagent-evidence-tool.js";
import { createOwnerConversationTools } from "../../src/tools/roles/owner-conversation-tools.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { sourceMetadataSymbol } from "../../src/tools/discovery/source-metadata-receipts.js";

// Business purpose: computes a canonical sha256 digest string for test fixture files.
// Technical description: hashes UTF-8 string content and prefixes with sha256:.
function sha(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

test("parent broad discovery, targeted read, and Git read tools are blocked with SUBAGENT_REQUIRED until valid delegation receipt exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nf-mandatory-subagent-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "workflows/agents/coder"), { recursive: true });
    writeFileSync(join(dir, "src/feature.js"), "export function computeValue() {\n  return 42;\n}\n", "utf8");
    writeFileSync(join(dir, "AGENTS.md"), "# Project Rules\n", "utf8");
    writeFileSync(join(dir, "workflows/agents/coder/README.md"), "# Coder README\n", "utf8");

    const fileService = createFileService({ projectRoot: dir });
    const evidenceStore = createSubagentEvidenceStore({ projectRoot: dir, projectId: "proj-mandatory" });
    const events = [];
    const parentContext = {
      task_id: "TASK-MANDATORY-1",
      execution_id: "EXEC-MANDATORY-1",
      correlation_id: "EXEC-MANDATORY-1",
      conversation_id: "CONV-SE-PLAN-99",
      project_root: dir,
      mandatory_subagent_discovery: true,
      agent_identity: { agent_id: "se-main", role: "system_engineer", provider: "anthropic" },
      projectLogger: (ev) => events.push(ev)
    };

    const tools = createOwnerConversationTools({
      role: "system_engineer",
      projectRoot: dir,
      fileService,
      gitService: {
        status: async () => " M src/feature.js\n",
        diffWorkingTree: async () => "diff --git a/src/feature.js b/src/feature.js\n"
      },
      conversationId: "CONV-SE-PLAN-99",
      projectLogger: (ev) => events.push(ev),
      context: parentContext,
      evidenceStore,
      delegateSubagentExecutor: async (task, childContext) => {
        // Child subagent has read_only_enforced: true and subagent_depth: 1, so it can run discovery tools directly
        const childTools = createOwnerConversationTools({
          role: "system_engineer",
          projectRoot: dir,
          fileService,
          conversationId: "CONV-SE-PLAN-99",
          context: childContext,
          evidenceStore,
          readOnlyExplorer: true
        });
        const meta = await childTools.registry.read_file.execute({ path: "src/feature.js" }, childContext);
        return {
          summary: `Explored ${task.id}: found ${meta.symbol_map.length} symbols`,
          observed_files: childContext.observed_files
        };
      }
    });

    // 1. Broad discovery tools must be rejected with SUBAGENT_REQUIRED
    await assert.rejects(
      () => tools.registry.search_tree.execute({ path: "src" }, parentContext),
      (err) => {
        assert.equal(err.code, "SUBAGENT_REQUIRED");
        assert.equal(err.error_code, "SUBAGENT_REQUIRED");
        assert.equal(err.required_action, "delegate_subagent");
        assert.deepEqual(err.allowed_tools, ["search_tree", "list_files", "search_text", "read_file", "Read"]);
        return true;
      }
    );

    await assert.rejects(
      () => tools.registry.read_file.execute({ path: "src/feature.js" }, parentContext),
      (err) => err.code === "SUBAGENT_REQUIRED"
    );

    await assert.rejects(
      () => tools.registry.git_status.execute({}, parentContext),
      (err) => err.code === "SUBAGENT_REQUIRED"
    );

    assert.ok(events.some((ev) => ev.event_name === "subagent.parent_discovery_rejected" && ev.error_code === "SUBAGENT_REQUIRED"));

    // 2. Controlled exception: mandatory rule files (AGENTS.md and role README.md) are allowed without delegation
    const agentsDoc = await tools.registry.read_file.execute({ path: "AGENTS.md" }, parentContext);
    assert.equal(agentsDoc.path, "AGENTS.md");
    const coderReadme = await tools.registry.read_file.execute({ path: "workflows/agents/coder/README.md" }, parentContext);
    assert.equal(coderReadme.path, "workflows/agents/coder/README.md");

    // 3. Controlled exception: owner explicitly specified file path
    parentContext.owner_explicit_paths = ["src/explicit.js"];
    writeFileSync(join(dir, "src/explicit.js"), "export const explicit = true;\n", "utf8");
    const explicitMeta = await tools.registry.read_file.execute({ path: "src/explicit.js" }, parentContext);
    assert.equal(explicitMeta.path, "src/explicit.js");

    // 4. Delegate discovery to subagent; child reads src/feature.js and records provenance receipt
    const delRes = await tools.registry.delegate_subagent.execute({
      tasks: [{ id: "inspect-feature", objective: "Inspect feature.js symbols and exports", paths: ["src"] }]
    }, parentContext);
    assert.equal(delRes.status, "completed");
    assert.equal(delRes.read_only, true);
    assert.equal(delRes.observed_files.length, 1);
    assert.equal(delRes.observed_files[0].read_only_enforced, true);

    // 5. Parent calls read_subagent_evidence({}) and reuses fresh evidence to call Read({ file_path, symbol }) directly
    const evSnap = await tools.registry.read_subagent_evidence.execute({}, parentContext);
    const featureEv = evSnap.evidence.find((e) => e.path === "src/feature.js");
    assert.ok(featureEv);
    assert.equal(featureEv.fresh, true);
    assert.equal(featureEv.provenance.read_only_enforced, true);
    assert.ok(sourceMetadataSymbol(parentContext, "src/feature.js", "computeValue", featureEv.sha256));

    const symbolRead = await tools.registry.Read.execute({ file_path: "src/feature.js", symbol: "computeValue" }, parentContext);
    assert.match(symbolRead.content, /return 42/);

    // 6. If file on disk changes, stored checksum becomes stale and fresh-checksum exception no longer applies without valid delegation covering path
    writeFileSync(join(dir, "src/other-dir.js"), "export const x = 1;\n", "utf8");
    parentContext.active_file_checksums = { "src/other-dir.js": sha("old-stale-content") };
    parentContext.delegation_receipts = [];
    await assert.rejects(
      () => tools.registry.read_file.execute({ path: "src/other-dir.js" }, parentContext),
      (err) => err.code === "SUBAGENT_REQUIRED"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delegation receipt validation rejects fake objectives, scope mismatches, out-of-scope paths, and expired delegations", async () => {
  assert.equal(isMeaningfulDelegationObjective(""), false);
  assert.equal(isMeaningfulDelegationObjective("do discovery"), false);
  assert.equal(isMeaningfulDelegationObjective("explore code"), false);
  assert.equal(isMeaningfulDelegationObjective("search"), false);
  assert.equal(isMeaningfulDelegationObjective("Inspect authentication middleware and token verifier"), true);

  const tool = createDelegateSubagentTool({ executeTask: async () => ({ summary: "ok", observed_files: [] }) });
  await assert.rejects(
    () => tool.execute({ tasks: [{ id: "fake", objective: "do discovery" }] }, { execution_id: "exec-1" }),
    (err) => err.code === "SUBAGENT_OBJECTIVE_INVALID"
  );

  // Scope mismatch check
  const contextA = { execution_id: "exec-A", conversation_id: "conv-A", mandatory_subagent_discovery: true };
  recordDelegationReceipt(contextA, {
    delegation_id: "DEL-A",
    status: "completed",
    read_only_enforced: true,
    tasks: [{ id: "t1", objective: "Inspect auth module in backend/src/auth", paths: ["backend/src/auth"] }]
  });

  const contextB = {
    execution_id: "exec-B",
    conversation_id: "conv-B",
    mandatory_subagent_discovery: true,
    delegation_receipts: contextA.delegation_receipts
  };
  assert.throws(
    () => assertDelegatedDiscoveryRequired(contextB, "search_tree", { path: "backend/src/auth" }),
    (err) => err.code === "SUBAGENT_REQUIRED" && err.details.reason === "DELEGATION_SCOPE_MISMATCH"
  );

  // Out-of-scope path check on contextA
  assert.throws(
    () => assertDelegatedDiscoveryRequired(contextA, "search_tree", { path: "ui/nextjs" }),
    (err) => err.code === "SUBAGENT_REQUIRED" && err.details.reason === "DELEGATION_PATH_OUTSIDE_SCOPE"
  );

  // In-scope path succeeds on contextA
  const allowed = assertDelegatedDiscoveryRequired(contextA, "search_tree", { path: "backend/src/auth/login.js" });
  assert.equal(allowed.allowed, true);

  // Expiry check
  const expiredContext = { execution_id: "exec-exp", conversation_id: "conv-exp", mandatory_subagent_discovery: true };
  recordDelegationReceipt(expiredContext, {
    delegation_id: "DEL-EXP",
    status: "completed",
    read_only_enforced: true,
    expires_at: new Date(Date.now() - 5000).toISOString(),
    tasks: [{ id: "t1", objective: "Inspect expired module" }]
  });
  assert.equal(validateDelegationReceipt(expiredContext.delegation_receipts[0], expiredContext).reason, "DELEGATION_EXPIRED");
  assert.throws(
    () => assertDelegatedDiscoveryRequired(expiredContext, "list_files", {}),
    (err) => err.code === "SUBAGENT_REQUIRED" && err.details.reason === "DELEGATION_EXPIRED"
  );
});

test("child subagent enforces read-only tools, blocks mutation and nested delegation, and provider failure grants fallback_to_parent", async () => {
  const events = [];
  const delegateTool = createDelegateSubagentTool({
    executeTask: async (task, childContext) => {
      // Child cannot call mutation tools
      assert.throws(() => childContext.assertToolAllowed("edit_diff"), (err) => err.code === "SUBAGENT_TOOL_FORBIDDEN");
      assert.throws(() => childContext.assertToolAllowed("write_diff"), (err) => err.code === "SUBAGENT_TOOL_FORBIDDEN");
      // Child cannot nest another delegate_subagent call
      await assert.rejects(
        () => delegateTool.execute({ tasks: [{ id: "nested", objective: "Attempt nested subagent discovery" }] }, childContext),
        (err) => err.code === "SUBAGENT_NESTING_FORBIDDEN"
      );
      if (task.id === "failover-all") {
        return {
          status: "fallback_to_parent",
          fallback_to_parent: true,
          summary: "Both claude-haiku-4-5 and Claude-luna timed out."
        };
      }
      return { summary: "completed", observed_files: [] };
    }
  });

  const parentContext = {
    execution_id: "exec-fallback",
    conversation_id: "conv-fallback",
    mandatory_subagent_discovery: true,
    projectLogger: (ev) => events.push(ev)
  };

  const res = await delegateTool.execute({
    tasks: [{ id: "failover-all", objective: "Inspect module when providers fail" }]
  }, parentContext);

  assert.equal(res.status, "fallback_to_parent");
  assert.equal(res.fallback_to_parent, true);
  assert.ok(parentContext.subagent_fallback_to_parent?.fallback_to_parent);

  // Parent is now permitted to run discovery directly under fallback_to_parent exception
  const check = assertDelegatedDiscoveryRequired(parentContext, "search_tree", { path: "backend/src" });
  assert.equal(check.allowed, true);
  assert.equal(check.exception, "fallback_to_parent");
  assert.ok(events.some((ev) => ev.event_name === "subagent.fallback_parent_discovery"));
});

test("evidence store links provenance receipt with semantic candidate relevance receipt and compacts large snapshots to save tokens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nf-evidence-compact-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    const store = createSubagentEvidenceStore({ projectRoot: dir, projectId: "proj-compact" });
    const evidenceTool = createSubagentEvidenceTool({ evidenceStore: store, projectRoot: dir });

    // Record candidate relevance receipt first (Step 1)
    const contentA = "export function targetFn() { return 'ok'; }\n";
    writeFileSync(join(dir, "src/target.js"), contentA, "utf8");
    store.recordCandidateReceipt({
      projectRoot: dir,
      projectId: "proj-compact",
      role: "system_engineer",
      conversationId: "CONV-COMPACT-1",
      delegationId: "DEL-COMPACT-1",
      path: "src/target.js",
      sha256: sha(contentA),
      retrieval_id: "RET-101",
      source: "ticket",
      matched_ac: ["AC1", "AC2"],
      matched_intents: ["delegated discovery enforcement"],
      score: 0.96,
      confidence: "high",
      reasons: ["semantic_embedding", "lexical_identifier"]
    });

    // Record subagent provenance receipt on the same file (Step 2 & 3)
    await store.complete({
      projectRoot: dir,
      projectId: "proj-compact",
      role: "system_engineer",
      conversationId: "CONV-COMPACT-1",
      delegationId: "DEL-COMPACT-1",
      workerId: "se:sub:explorer-1",
      parentAgentId: "se",
      status: "completed",
      summary: "Observed target.js",
      observedFiles: [{
        path: "src/target.js",
        sha256: sha(contentA),
        total_lines: 2,
        symbol_map: [{ name: "targetFn", kind: "function", start_line: 1, end_line: 1, summary: "Long summary text" }],
        symbols_read: ["targetFn"],
        parent_execution_id: "EXEC-1",
        child_execution_id: "EXEC-1:sub:explorer-1",
        child_agent_id: "se:sub:explorer-1",
        source_tool: "read_file"
      }]
    });

    // Populate 20 additional files with heavy symbol maps to trigger token-saving compact mode
    for (let i = 0; i < 20; i += 1) {
      const p = `src/extra-${i}.js`;
      const text = `export function extra${i}() { return ${i}; }\n`;
      writeFileSync(join(dir, p), text, "utf8");
      const heavySymbols = Array.from({ length: 40 }, (_, idx) => ({
        name: `sym_${i}_${idx}`,
        kind: "function",
        start_line: 1,
        end_line: 1,
        summary: "Very verbose AST symbol description ".repeat(8)
      }));
      store.recordDirectEvidence({
        projectRoot: dir,
        projectId: "proj-compact",
        role: "architecture_manager",
        conversationId: `CONV-OLD-${i}`,
        delegationId: `DEL-OLD-${i}`,
        path: p,
        sha256: sha(text),
        total_lines: 2,
        symbol_map: heavySymbols,
        code_graph: { imports: heavySymbols.map((s) => s.name), imported_by: heavySymbols.map((s) => s.name) }
      });
    }

    const context = {
      conversation_id: "CONV-COMPACT-1",
      execution_id: "DEL-COMPACT-1",
      project_root: dir,
      agent_identity: { role: "system_engineer", agent_id: "se" }
    };
    const snap = await evidenceTool.execute({ delegation_id: "DEL-COMPACT-1" }, context);

    assert.equal(snap.compact, true);
    assert.equal(snap.total_evidence_count, 21);
    assert.ok(snap.returned_evidence_count <= 16);
    assert.ok(JSON.stringify(snap).length < 32000, "Compacted snapshot must stay well below token limits");

    // Verify linked provenance + relevance on src/target.js
    const targetEntry = snap.evidence.find((e) => e.path === "src/target.js");
    assert.ok(targetEntry);
    assert.equal(targetEntry.fresh, true);
    assert.equal(targetEntry.provenance.source_worker_id, "se:sub:explorer-1");
    assert.equal(targetEntry.provenance.read_only_enforced, true);
    assert.equal(targetEntry.relevance.retrieval_id, "RET-101");
    assert.deepEqual(targetEntry.relevance.matched_ac, ["AC1", "AC2"]);

    // Even for compacted/omitted fresh files, recordSourceMetadata was registered on context!
    assert.ok(sourceMetadataSymbol(context, "src/extra-19.js", "sym_19_0", sha("export function extra19() { return 19; }\n")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
