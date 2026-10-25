/** Verifies native output schemas reach Codex on both new and resumed turns,
 * while progress narration stays separate from the terminal exchange response.
 * The SDK stub avoids external requests and writes only to an isolated home. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexSdkGateway } from "../../src/modules/agent/codex-sdk-gateway.js";
import { createAgentExchangeOutput } from "../../src/modules/governance/agent-exchange-output.js";

test("new and resumed Codex turns retain native schema and only the last response", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-codex-output-"));
  const schema = createAgentExchangeOutput({ kind: "consultation_request", recipient: { role: "architecture_manager" } }).schema;
  const value = { kind: "consultation_response", subject: "One question answered.", payload: {}, evidence: [] };
  const calls = [];
  try {
    const gateway = createCodexSdkGateway({ codexHomeRoot: root, terminalOutput: { write() {} },
      configuration: { getById: () => ({ agent_id: "AM", role: "architecture_manager", gateway_url: "https://gateway.test",
        credential_ref: "fixture", enabled: true, status: "ready" }) }, credentialResolver: () => "fixture-key",
      CodexClass: class {
        // Records new-thread dispatch while preserving the same streaming SDK surface.
        startThread() { calls.push("start"); return this.resumeThread("T", true); }
        // Simulates a resumed SDK stream with intermediate narration and a final JSON response.
        resumeThread(id, initial = false) {
          if (initial !== true) calls.push("resume");
          return { id, runStreamed: async (_prompt, options) => {
            assert.deepEqual(options.outputSchema, schema);
            assert(options.signal instanceof AbortSignal);
            return { events: (async function* () {
              yield { type: "item.completed", item: { type: "agent_message", text: "I'm retrieving evidence." } };
              yield { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } };
              yield { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 4 } };
            })() };
          } };
        }
      } });
    for (const resumeThreadId of [undefined, "T"]) {
      const result = await gateway.execute({ agentId: "AM", prompt: "Answer the retained question.", correlationId: "STRUCTURED",
        resumeThreadId, options: { outputSchema: schema } });
      assert.equal(result.text, JSON.stringify(value));
      assert.equal(result.thread_id, "T");
      assert.equal(result.items.length, 2);
    }
    assert.deepEqual(calls, ["start", "resume"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
