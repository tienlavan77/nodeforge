import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttemptContextBuilder } from "../../src/modules/supervisor/attempt-context-builder.js";
import { createProtocolStorage } from "../../src/infrastructure/storage/protocol-storage.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";

const TICKET = { id: "TASK-ACB", project_id: "PROJECT-NODEFORGE", title: "Add summary", objective: "Add a summary", acceptance_criteria: ["Summary added"] };

function originRequest(overrides = {}) {
  return {
    task_id: "TASK-ACB",
    project_id: "PROJECT-NODEFORGE",
    request_id: "REQ-ACB",
    correlation_id: "CORR-ACB",
    attempt: 1,
    agent_id: "builder",
    ticket: TICKET,
    ...overrides
  };
}

async function builderHarness({ memoryFacts = [] } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "attempt-builder-"));
  const fileService = createFileService({ projectRoot: dataDir });
  const protocolStorage = createProtocolStorage({ fileService, root: "protocol" });
  const logs = [];
  const builder = createAttemptContextBuilder({
    protocolStorage,
    projectLogger: (entry) => logs.push(entry),
    memoryRetriever: { retrieve: async () => ({ relevant_facts: memoryFacts }) }
  });
  return { builder, protocolStorage, logs, fileService };
}

test("attempt 1 builds and persists the session request", async () => {
  const { builder, protocolStorage, logs } = await builderHarness();
  const envelope = await builder.buildAttemptRequest(originRequest());
  assert.equal(envelope.type, "task");
  assert.equal(envelope.payload.step_id, 1);
  assert.equal(envelope.task_id, "TASK-ACB");
  assert.ok(Array.isArray(envelope.payload.instruction_blocks));
  const persisted = (await protocolStorage.get("task/TASK-ACB/round_1/request")).data;
  assert.equal(persisted.request_id, envelope.request_id);
  assert.ok(logs.some((entry) => entry.event_name === "supervisor.request_persisted"));
});

test("attempt 1 includes project memory facts in the stable user blocks", async () => {
  const { builder } = await builderHarness({ memoryFacts: ["Always validate checksums before apply."] });
  const envelope = await builder.buildAttemptRequest(originRequest());
  const memoryBlock = envelope.payload.user_blocks.find((block) => block.block_id === "project-memory");
  assert.ok(memoryBlock, "expected project-memory block");
  assert.ok(memoryBlock.content.includes("Always validate checksums before apply."));
  assert.equal(memoryBlock.cacheable, true);
});

test("repair attempt reuses attempt 1 prefix and appends failure context last", async () => {
  const { builder, protocolStorage } = await builderHarness();
  const first = await builder.buildAttemptRequest(originRequest());
  const repair = await builder.buildRepairRequest(
    { ...originRequest(), attempt: 2 },
    { reason: "verification", failures: [{ path: "src/a.js", message: "checksum mismatch" }] }
  );
  assert.equal(repair.request_id !== first.request_id, true);
  assert.equal(repair.parent_id, first.request_id);
  assert.equal(repair.payload.step_id, 2);
  const lastBlock = repair.payload.user_blocks.at(-1);
  assert.equal(lastBlock.block_id, "repair-context-attempt-2");
  assert.ok(lastBlock.content.includes("checksum mismatch"));
  assert.equal(lastBlock.cacheable, false);
  assert.equal(repair.payload.metadata.retry_of_step, 1);
  const persisted = (await protocolStorage.get("task/TASK-ACB/round_2/request")).data;
  assert.equal(persisted.request_id, repair.request_id);
});

test("onResponse records an append-only transcript block", async () => {
  const { builder } = await builderHarness();
  await builder.buildAttemptRequest(originRequest());
  await builder.onResponse({ event: { task_id: "TASK-ACB", request_id: "REQ-ACB", correlation_id: "CORR-ACB", attempt: 1 }, response: { type: "session.result", summary: "done", response_id: "resp-1" } });
  const blocks = builder.getTranscriptBlocks();
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].round, 1);
  assert.equal(blocks[0].response_id, "resp-1");
  await builder.onResponse({ event: { task_id: "TASK-ACB", request_id: "REQ-ACB", correlation_id: "CORR-ACB", attempt: 1 }, response: { type: "session.result" } });
  assert.equal(builder.getTranscriptBlocks().length, 1, "duplicate request_id must not append twice");
});

test("execution context provider is applied to both attempt kinds", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "attempt-builder-ctx-"));
  const fileService = createFileService({ projectRoot: dataDir });
  const protocolStorage = createProtocolStorage({ fileService, root: "protocol" });
  const contexts = [];
  const builder = createAttemptContextBuilder({
    protocolStorage,
    executionContextProvider: async ({ round, type }) => {
      const context = { task_id: "TASK-ACB", execution_id: `SUP:${round}`, agent_identity: { agent_id: "builder", role: "coder" }, capabilities: [], lifecycle: "RUNNING", kind: type };
      contexts.push(context);
      return context;
    }
  });
  const first = await builder.buildAttemptRequest(originRequest());
  assert.equal(first.payload.execution_context.kind, "task");
  await builder.buildRepairRequest({ ...originRequest(), attempt: 2 }, { reason: "verification" });
  assert.equal(contexts.at(-1).kind, "repair");
});
