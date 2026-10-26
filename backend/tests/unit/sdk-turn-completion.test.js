/** Checks the actual provider gateways expose confirmed turn completion only
 * after their terminal success event, so orchestration never replays an
 * interrupted or ambiguous provider stream as a normal phase boundary. */
import assert from "node:assert/strict";
import test from "node:test";
import { createClaudeSdkGateway } from "../../src/modules/agent/claude-sdk-gateway.js";
import { createTestCodexSdkGateway as createCodexSdkGateway } from "../fixtures/codex-sdk-fixture.js";

// Both provider adapters must distinguish a final message from terminal success.
for (const provider of ["claude", "codex"]) for (const completed of [false, true]) {
  test(`${provider} reports confirmed SDK completion=${completed}`, async () => {
    const profile = { agent_id: "CODER", role: "coder", provider, enabled: true, status: "ready", gateway_url: "https://gateway.example.test/v1", credential_ref: "test", model: "test" };
    const common = { configuration: { getById: () => profile }, credentialResolver: () => "test-key", terminalOutput: { write() {} } };
    const gateway = provider === "claude" ? createClaudeSdkGateway({ ...common,
      queryFn: () => (async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "Discovery complete" }] } };
        if (completed) yield { type: "result", subtype: "success", is_error: false, result: "Discovery complete" };
      })()
    }) : createCodexSdkGateway({ ...common,
      CodexClass: class {
        startThread() { return { id: "THREAD", runStreamed: async () => ({ events: (async function* () {
          yield { type: "item.completed", item: { type: "agent_message", text: "Discovery complete" } };
          if (completed) yield { type: "turn.completed" };
        })() }) }; }
      }
    });
    const result = await gateway.execute({ agentId: "CODER", correlationId: "TURN-STATUS", prompt: "Continue" });
    assert.equal(result.turn_completed, completed);
    assert.equal(result.text, "Discovery complete");
  });
}
