// Verifies the SDK deadline is typed and a session remains owned until stream teardown completes.
// Uses an abortable local SDK stub so no provider or production agent is invoked.
import assert from "node:assert/strict";
import test from "node:test";
import { createTestCodexSdkGateway } from "../fixtures/codex-sdk-fixture.js";

test("SDK timeout reports a typed cause and confirms stopped only after the invocation ends", async () => {
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const gateway = createTestCodexSdkGateway({ timeoutMs: 100,
    configuration: { getById: () => ({ agent_id: "timeout-probe", provider: "codex", enabled: true, status: "ready", gateway_url: "https://gateway.test", credential_ref: "test" }) },
    credentialResolver: () => "test-key", terminalOutput: { write() {} },
    CodexClass: class {
      startThread() { return { id: "THREAD", runStreamed: async (_prompt, { signal }) => ({ events: (async function* () {
        yield { type: "turn.started" };
        started();
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
      })() }) }; }
    } });
  const run = gateway.execute({ agentId: "timeout-probe", correlationId: "CORR", prompt: "Continue" });
  const rejected = assert.rejects(run, { code: "SDK_REQUEST_TIMEOUT", provider_outcome: "unknown", retry_safe: false });
  await entered;
  assert.throws(() => gateway.assertSessionStopped({ agentId: "timeout-probe", threadId: "THREAD" }), { code: "EXECUTION_SESSION_BUSY" });
  await rejected;
  assert.doesNotThrow(() => gateway.assertSessionStopped({ agentId: "timeout-probe", threadId: "THREAD" }));
});
