import assert from "node:assert/strict";
import test from "node:test";
import { createAgentTranscriptStore } from "../../src/modules/agent/agent-transcript-store.js";

test("supports full transcript and rolling summary modes", () => {
  const store = createAgentTranscriptStore();
  store.append({ taskId: "T", round: 1, instruction: "one", responseSummary: "s1", fullRequest: "request one", fullResponse: "response one" });
  store.append({ taskId: "T", round: 2, instruction: "two", responseSummary: "s2", fullRequest: "request two", fullResponse: "response two" });
  assert.equal(store.select("T", { mode: "full_transcript" })[0].full_request_ref.startsWith("task/T/round_1"), true);
  assert.equal(store.select("T", { mode: "rolling_summary" })[0].full_request, undefined);
});

test("hybrid mode keeps only the newest window and downgrades on budget", () => {
  const downgrades = [];
  const store = createAgentTranscriptStore({ onDowngrade: (event) => downgrades.push(event) });
  for (let round = 1; round <= 4; round += 1) store.append({ taskId: "T", round, instruction: "x".repeat(100), responseSummary: `s${round}`, fullRequest: "x".repeat(5000), fullResponse: "y".repeat(5000) });
  const result = store.select("T", { mode: "hybrid", hybridWindow: 2, maxTokens: 100 });
  assert.equal(result.length, 4);
  assert.equal(downgrades.length > 0, true);
});

test("persists full request and response envelopes through Protocol Storage", async () => {
  const saved = [];
  const store = createAgentTranscriptStore({
    protocolStorage: {
      save: async (ref, data, options) => { saved.push({ ref, data, options }); }
    }
  });
  store.append({ taskId: "TASK-PERSIST", round: 1, fullRequest: '{"type":"task"}', fullResponse: "done" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved.length, 2);
  assert.equal(saved[0].ref, "task/TASK-PERSIST/round_1/request");
  assert.deepEqual(saved[0].data, { type: "task" });
  assert.equal(saved[1].ref, "task/TASK-PERSIST/round_1/response");
  assert.deepEqual(saved[1].data, { text: "done" });
});
