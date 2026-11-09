// Business purpose: verifies the 3-tier subagent model failover chain (claude-haiku-4-5 <-> Claude-luna -> fallback_to_parent), durable per-agent evidence store, direct parent read/mutation sync, cross-role AM <-> SE <-> RV sharing, and automatic recordSourceMetadata registration.
// Technical description: exercises claudeSdkGateway, codexSdkGateway, executeSubagentWithFailover, createSubagentEvidenceStore, createSubagentEvidenceTool, createOwnerConversationTools, and bindEngineeringTools in isolated temp directories.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createClaudeSdkGateway } from "../../src/modules/agent/claude-sdk-gateway.js";
import { createCodexSdkGateway } from "../../src/modules/agent/codex-sdk-gateway.js";
import { createSubagentEvidenceStore } from "../../src/tools/discovery/subagent-evidence-store.js";
import { createSubagentEvidenceTool } from "../../src/tools/discovery/subagent-evidence-tool.js";
import { createDelegateSubagentTool } from "../../src/tools/discovery/delegate-subagent-tool.js";
import { executeSubagentWithFailover, resolveSubagentFailoverCandidates } from "../../src/tools/discovery/subagent-failover-executor.js";
import { sourceMetadataSymbol } from "../../src/tools/discovery/source-metadata-receipts.js";
import { createOwnerConversationTools } from "../../src/tools/roles/owner-conversation-tools.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { bindEngineeringTools } from "../../src/tools/engineering-tool-binding.js";
import { CODER_TOOL_NAMES } from "../../src/tools/engineering-tool-catalog.js";

// Business purpose: computes a canonical sha256 string for test fixture files.
// Technical description: hashes UTF-8 text and prefixes with sha256:.
function sha(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

test("claude-sdk-gateway and codex-sdk-gateway default subagent models to claude-haiku-4-5 and Claude-luna with low effort and accurate terminal logs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nf-subagent-gw-"));
  try {
    let claudeQueryOpts = null;
    let claudeLogOutput = "";
    const claudeGateway = createClaudeSdkGateway({
      claudeHomeRoot: join(dir, "claude-homes"),
      configuration: {
        getById: () => ({ agent_id: "se-claude", agent_name: "SE Claude", role: "system_engineer", provider: "anthropic", model: "claude-opus-4-6", gateway_url: "https://gateway.test/v1", credential_ref: "cred", enabled: true, status: "ready" })
      },
      credentialResolver: async () => "secret-token",
      terminalOutput: { write: (chunk) => { claudeLogOutput += chunk; } },
      queryFn: ({ options }) => {
        claudeQueryOpts = options;
        return (async function* () {
          yield { type: "result", subtype: "success", result: "explored" };
        })();
      }
    });
    await claudeGateway.execute({ agentId: "se-claude", subagentId: "worker-1", correlationId: "CORR-SUB-CLAUDE", prompt: "Inspect files", cwd: dir });
    assert.equal(claudeQueryOpts.model, "claude-haiku-4-5");
    assert.equal(claudeQueryOpts.effort, "low");
    assert.match(claudeLogOutput, /model=claude-haiku-4-5/);

    let codexThreadOpts = null;
    let codexLogOutput = "";
    const codexGateway = createCodexSdkGateway({
      codexHomeRoot: join(dir, "codex-homes"),
      configuration: {
        getById: () => ({ agent_id: "se-codex", agent_name: "SE Codex", role: "system_engineer", provider: "codex", model: "gpt-5.4", gateway_url: "https://gateway.test/v1", credential_ref: "cred", enabled: true, status: "ready" })
      },
      credentialResolver: async () => "secret-token",
      terminalOutput: { write: (chunk) => { codexLogOutput += chunk; } },
      CodexClass: class {
        startThread(opts) {
          codexThreadOpts = opts;
          return {
            id: "thread-sub-1",
            runStreamed: async () => ({
              events: (async function* () {
                yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "explored codex" } };
                yield { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } };
              })()
            })
          };
        }
      }
    });
    await codexGateway.execute({ agentId: "se-codex", subagentId: "worker-2", correlationId: "CORR-SUB-CODEX", prompt: "Inspect files", cwd: dir });
    assert.equal(codexThreadOpts.model, "Claude-luna");
    assert.equal(codexThreadOpts.modelReasoningEffort, "low");
    assert.match(codexLogOutput, /Claude-luna/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("3-tier subagent failover chain handles Claude primary -> Claude-luna fallback -> fallback_to_parent and Codex primary -> claude-haiku-4-5 fallback -> fallback_to_parent", async () => {
  assert.deepEqual(resolveSubagentFailoverCandidates("anthropic").map((c) => c.model), ["claude-haiku-4-5", "Claude-luna"]);
  assert.deepEqual(resolveSubagentFailoverCandidates("codex").map((c) => c.model), ["Claude-luna", "claude-haiku-4-5"]);

  const claudeAttempts = [];
  const claudeFailoverRes = await executeSubagentWithFailover({
    parentProvider: "anthropic",
    parentProfile: { agent_id: "am-1", role: "architecture_manager", provider: "anthropic" },
    childContext: { observed_files: [{ path: "src/a.js", sha256: sha("a") }] },
    runCandidate: async ({ provider, model }) => {
      claudeAttempts.push(`${provider}:${model}`);
      if (model === "claude-haiku-4-5") throw new Error("Anthropic 503 overloaded");
      return { summary: "Recovered on Claude-luna", observed_files: [{ path: "src/a.js", sha256: sha("a") }] };
    }
  });
  assert.deepEqual(claudeAttempts, ["anthropic:claude-haiku-4-5", "codex:Claude-luna"]);
  assert.equal(claudeFailoverRes.status, "completed");
  assert.equal(claudeFailoverRes.subagent_model, "Claude-luna");
  assert.equal(claudeFailoverRes.fallback_to_parent, false);

  const codexAttempts = [];
  const codexFailoverRes = await executeSubagentWithFailover({
    parentProvider: "codex",
    parentProfile: { agent_id: "se-1", role: "system_engineer", provider: "codex" },
    childContext: { observed_files: [{ path: "src/b.js", sha256: sha("b") }] },
    runCandidate: async ({ provider, model }) => {
      codexAttempts.push(`${provider}:${model}`);
      if (model === "Claude-luna") throw new Error("Codex channel unavailable");
      return { summary: "Recovered on claude-haiku-4-5", observed_files: [{ path: "src/b.js", sha256: sha("b") }] };
    }
  });
  assert.deepEqual(codexAttempts, ["codex:Claude-luna", "anthropic:claude-haiku-4-5"]);
  assert.equal(codexFailoverRes.status, "completed");
  assert.equal(codexFailoverRes.subagent_model, "claude-haiku-4-5");

  const partialObserved = [{ path: "src/partial.js", sha256: sha("partial"), symbols_read: ["init"], symbol_map: [{ name: "init", kind: "function", start_line: 1, end_line: 3 }] }];
  const childCtx = { observed_files: partialObserved };
  const bothFailedRes = await executeSubagentWithFailover({
    parentProvider: "claude",
    parentProfile: { agent_id: "se-1", role: "system_engineer", provider: "claude" },
    childContext: childCtx,
    runCandidate: async () => {
      throw new Error("Upstream model outage");
    }
  });
  assert.equal(bothFailedRes.status, "fallback_to_parent");
  assert.equal(bothFailedRes.fallback_to_parent, true);
  assert.equal(bothFailedRes.observed_files.length, 1);

  const store = createSubagentEvidenceStore();
  const delegateTool = createDelegateSubagentTool({
    evidenceStore: store,
    executeTask: async (_task, child) => {
      child.observed_files = partialObserved;
      return executeSubagentWithFailover({
        parentProvider: "anthropic",
        childContext: child,
        runCandidate: async () => { throw new Error("Both failed"); }
      });
    }
  });
  const parentCtx = { task_id: "T-FALLBACK", execution_id: "EXEC-1", conversation_id: "CONV-1", agent_identity: { agent_id: "SE-1", role: "system_engineer", provider: "anthropic" } };
  const batchRes = await delegateTool.execute({ tasks: [{ id: "w1", objective: "explore module" }] }, parentCtx);
  assert.equal(batchRes.status, "fallback_to_parent");
  assert.equal(batchRes.fallback_to_parent, true);
  assert.equal(batchRes.observed_files.length, 1);
  assert.equal(batchRes.observed_files[0].path, "src/partial.js");
});

test("durable per-agent evidence store persists across turns, records direct parent read_file/Read/edit_diff, shares across AM <-> SE <-> RV, and auto-registers recordSourceMetadata for fresh files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nf-evidence-store-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    const fileContentV1 = "// File header comment for module alpha.\nexport function alpha() {\n  return 1;\n}\n";
    writeFileSync(join(dir, "src/alpha.js"), fileContentV1, "utf8");
    const outOfScopeContent = "// Out of scope file.\nexport function secretHelper() {\n  return 42;\n}\n";
    writeFileSync(join(dir, "outside.js"), outOfScopeContent, "utf8");

    const fileService = createFileService({ projectRoot: dir });
    const store = createSubagentEvidenceStore({ projectRoot: dir, projectId: "proj-test" });

    // 1. AM reads src/alpha.js directly via read_file in Owner Conversation tools (plan_id: PLAN-123)
    const amContext = {
      task_id: "TURN-AM-1",
      execution_id: "TURN-AM-1",
      correlation_id: "TURN-AM-1",
      conversation_id: "CONV-AM-MAIN",
      project_root: dir,
      evidence_scope: { projectId: "proj-test", projectRoot: dir, role: "architecture_manager", conversationId: "CONV-AM-MAIN", planId: "PLAN-123", handoffId: "HANDOFF-PLAN-123-R1", delegationId: "TURN-AM-1" },
      agent_identity: { agent_id: "am-agent", role: "architecture_manager", provider: "anthropic" }
    };
    const amTools = createOwnerConversationTools({ role: "architecture_manager", projectRoot: dir, fileService, conversationId: "CONV-AM-MAIN", context: amContext, evidenceStore: store });
    amContext.capabilities = amTools.definitions.map((d) => d.name);

    await amTools.registry.read_file.execute({ path: "src/alpha.js" }, amContext);
    await amTools.registry.Read.execute({ file_path: "src/alpha.js", symbol: "alpha" }, amContext);
    assert.equal(existsSync(join(dir, ".forge/runtime/nf/evidence-stores/proj-test/architecture_manager.json")), true);

    // 2. SE runs on a different conversationId (CONV-SE-PLAN-123) and new executionId (TURN-SE-1) in the same handoff/plan flow
    const seContext = {
      task_id: "TURN-SE-1",
      execution_id: "TURN-SE-1",
      correlation_id: "TURN-SE-1",
      conversation_id: "CONV-SE-PLAN-123",
      project_root: dir,
      evidence_scope: { projectId: "proj-test", projectRoot: dir, role: "system_engineer", conversationId: "CONV-SE-PLAN-123", linkedConversationId: "CONV-AM-MAIN", planId: "PLAN-123", handoffId: "HANDOFF-PLAN-123-R1", delegationId: "TURN-SE-1" },
      agent_identity: { agent_id: "se-agent", role: "system_engineer", provider: "anthropic" }
    };
    const seTools = createOwnerConversationTools({ role: "system_engineer", projectRoot: dir, fileService, conversationId: "CONV-SE-PLAN-123", context: seContext, evidenceStore: store });
    seContext.capabilities = seTools.definitions.map((d) => d.name);

    // SE calls read_subagent_evidence({}) without having called read_file itself!
    const seEvidence = await seTools.registry.read_subagent_evidence.execute({}, seContext);
    const alphaEntry = seEvidence.evidence.find((e) => e.path === "src/alpha.js");
    assert.ok(alphaEntry, "SE must inherit AM evidence via cross-share");
    assert.equal(alphaEntry.fresh, true);
    assert.equal(alphaEntry.sha256, sha(fileContentV1));
    assert.equal(alphaEntry.source_role, "architecture_manager");
    assert.deepEqual(alphaEntry.symbols_read, ["alpha"]);

    // Verify recordSourceMetadata and active_file_checksums were automatically registered on seContext!
    assert.ok(sourceMetadataSymbol(seContext, "src/alpha.js", "alpha", sha(fileContentV1)), "recordSourceMetadata must be populated for SE");
    assert.equal(seContext.active_file_checksums?.["src/alpha.js"]?.sha256, sha(fileContentV1));

    // SE can immediately call Read({file_path, symbol}) AND edit_diff without calling read_file first!
    const directRead = await seTools.registry.Read.execute({ file_path: "src/alpha.js", symbol: "alpha" }, seContext);
    assert.match(directRead.content, /return 1;/);

    await seTools.registry.edit_diff.execute({
      path: "src/alpha.js",
      before_checksum: alphaEntry.sha256,
      anchor: "return 1;",
      replacement: "return 2;"
    }, seContext);

    // 3. RV runs on CONV-RV-PLAN-123 and calls read_subagent_evidence({}) — sees updated sha256 from SE's edit_diff!
    const rvContext = {
      task_id: "TURN-RV-1",
      execution_id: "TURN-RV-1",
      correlation_id: "TURN-RV-1",
      conversation_id: "CONV-RV-PLAN-123",
      project_root: dir,
      evidence_scope: { projectId: "proj-test", projectRoot: dir, role: "reviewer", conversationId: "CONV-RV-PLAN-123", linkedConversationId: "CONV-AM-MAIN", planId: "PLAN-123", handoffId: "HANDOFF-PLAN-123-R1", delegationId: "TURN-RV-1" },
      agent_identity: { agent_id: "rv-agent", role: "reviewer", provider: "codex" }
    };
    const rvTools = createOwnerConversationTools({ role: "reviewer", projectRoot: dir, fileService, conversationId: "CONV-RV-PLAN-123", context: rvContext, evidenceStore: store });
    rvContext.capabilities = rvTools.definitions.map((d) => d.name);

    const rvEvidence = await rvTools.registry.read_subagent_evidence.execute({}, rvContext);
    const rvAlpha = rvEvidence.evidence.find((e) => e.path === "src/alpha.js");
    const fileContentV2 = fileContentV1.replace("return 1;", "return 2;");
    assert.equal(rvAlpha.sha256, sha(fileContentV2));
    assert.equal(rvAlpha.fresh, true);
    assert.equal(rvAlpha.source_role, "system_engineer");

    // 4. Stale detection when file is modified externally on disk
    writeFileSync(join(dir, "src/alpha.js"), fileContentV2.replace("return 2;", "return 3;"), "utf8");
    const staleCheck = await rvTools.registry.read_subagent_evidence.execute({}, rvContext);
    assert.equal(staleCheck.evidence.find((e) => e.path === "src/alpha.js").fresh, false);
    assert.equal(staleCheck.evidence.find((e) => e.path === "src/alpha.js").stale, true);

    // Unreadable or missing disk files must fail closed (fresh: false, stale: true) and log freshness errors without registering metadata
    store.recordDirectEvidence({
      projectId: "proj-test",
      projectRoot: dir,
      role: "reviewer",
      conversationId: "CONV-RV-PLAN-123",
      delegationId: "TURN-RV-2",
      planId: "PLAN-123",
      handoffId: "HANDOFF-PLAN-123-R1",
      path: "src/missing-file.js",
      sha256: sha("missing")
    });
    const freshnessLogs = [];
    const unreadableContext = {
      project_id: "proj-test",
      project_root: dir,
      conversation_id: "CONV-RV-PLAN-123",
      execution_id: "TURN-RV-2",
      agent_identity: { agent_id: "rv-1", role: "reviewer" },
      project_logger: (evt) => freshnessLogs.push(evt),
      active_file_checksums: {},
      evidence_scope: {
        projectId: "proj-test",
        projectRoot: dir,
        role: "reviewer",
        conversationId: "CONV-RV-PLAN-123",
        linkedConversationId: "CONV-AM-MAIN",
        planId: "PLAN-123",
        handoffId: "HANDOFF-PLAN-123-R1",
        delegationId: "TURN-RV-2"
      }
    };
    const throwingTool = createSubagentEvidenceTool({
      evidenceStore: store,
      fileService: {
        async readForIndex({ path: p }) {
          if (p === "src/alpha.js") throw new Error("EACCES: permission denied reading src/alpha.js");
          return null;
        }
      },
      projectRoot: dir
    });
    const failClosedSnap = await throwingTool.execute({}, unreadableContext);
    const unreadableAlpha = failClosedSnap.evidence.find((e) => e.path === "src/alpha.js");
    assert.equal(unreadableAlpha.fresh, false);
    assert.equal(unreadableAlpha.stale, true);
    assert.match(unreadableAlpha.freshness_error, /EACCES: permission denied/);
    assert.equal(unreadableContext.active_file_checksums["src/alpha.js"], undefined);
    assert.ok(freshnessLogs.some((l) => l.event_name === "subagent_evidence.freshness_check_failed"));

    const missingEntry = failClosedSnap.evidence.find((e) => e.path === "src/missing-file.js");
    assert.equal(missingEntry.fresh, false);
    assert.equal(missingEntry.stale, true);
    assert.equal(unreadableContext.active_file_checksums["src/missing-file.js"], undefined);

    // Durability errors (mkdir, corrupt JSON parse, and write failures) are surfaced and logged
    const durabilityLogs = [];
    const blockedRoot = join(dir, "not-a-directory-file");
    writeFileSync(blockedRoot, "file blocking mkdir", "utf8");
    const mkdirFailStore = createSubagentEvidenceStore({ projectRoot: blockedRoot, projectId: "PROJ-MKDIR-FAIL" });
    const mkdirRes = mkdirFailStore.recordDirectEvidence({
      role: "system_engineer",
      conversationId: "conv-mkdir-fail",
      delegationId: "del-mkdir-fail",
      path: "src/x.js",
      sha256: sha("x"),
      projectLogger: (e) => durabilityLogs.push(e)
    });
    assert.equal(mkdirRes.durable, false);
    assert.ok(durabilityLogs.some((l) => l.event_name === "subagent_evidence.durability_error" && l.payload.operation === "mkdir"));

    const corruptDir = join(dir, ".forge/runtime/nf/evidence-stores/PROJ-CORRUPT");
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, "reviewer.json"), "{corrupted-json", "utf8");
    const corruptSnap = store.snapshot({
      projectId: "PROJ-CORRUPT",
      projectRoot: dir,
      role: "reviewer",
      conversationId: "conv-corrupt",
      delegationId: "del-corrupt",
      projectLogger: (e) => durabilityLogs.push(e)
    });
    assert.ok(Array.isArray(corruptSnap.durability_errors));
    assert.ok(corruptSnap.durability_errors.some((e) => e.operation === "read_parse"));

    const writeFailDir = join(dir, ".forge/runtime/nf/evidence-stores/PROJ-WRITE-FAIL");
    mkdirSync(join(writeFailDir, "coder.json"), { recursive: true }); // directory at file path causes writeFileSync to throw EISDIR
    const writeFailRes = store.recordDirectEvidence({
      projectId: "PROJ-WRITE-FAIL",
      projectRoot: dir,
      role: "coder",
      conversationId: "conv-write-fail",
      delegationId: "del-write-fail",
      path: "src/y.js",
      sha256: sha("y"),
      projectLogger: (e) => durabilityLogs.push(e)
    });
    assert.equal(writeFailRes.durable, false);
    assert.equal(writeFailRes.durability_error.operation, "write");
    assert.ok(durabilityLogs.some((l) => l.event_name === "subagent_evidence.durability_error" && l.payload.operation === "write"));

    // Restore disk to v2 and record an out-of-scope file in AM store to test Coder ticket scope filtering
    writeFileSync(join(dir, "src/alpha.js"), fileContentV2, "utf8");
    await amTools.registry.read_file.execute({ path: "outside.js" }, amContext);

    // 5. Coder in Ticket Runtime calls read_subagent_evidence and only receives files matching allowed_file_paths / allowed_prefixes
    const coderEvidenceTool = createSubagentEvidenceTool({ evidenceStore: store, fileService, projectRoot: dir });
    const coderContext = {
      task_id: "TICKET-1",
      execution_id: "TICKET-1:REQ-1",
      project_root: dir,
      agent_identity: { agent_id: "coder-1", role: "coder", provider: "claude" },
      capabilities: [...CODER_TOOL_NAMES],
      allowed_file_paths: [],
      allowed_prefixes: ["src/"]
    };
    const boundCoder = bindEngineeringTools({
      registry: { read_subagent_evidence: coderEvidenceTool },
      context: coderContext
    });
    const coderSnap = await boundCoder.registry.read_subagent_evidence.execute({});
    assert.deepEqual(coderSnap.evidence.map((e) => e.path), ["src/alpha.js"]);
    assert.equal(coderSnap.evidence[0].fresh, true);
    assert.ok(sourceMetadataSymbol(boundCoder.context, "src/alpha.js", "alpha", sha(fileContentV2)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
