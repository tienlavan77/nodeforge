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
