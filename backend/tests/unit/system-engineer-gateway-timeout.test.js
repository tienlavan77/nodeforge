// Verifies that long System Engineer sessions remain under owner control across all SDK gateways.
// Virtual time exercises the former session deadline without live providers or waiting an hour;
// other roles must still time out, and explicit Stop must cancel unlimited SE sessions.
import assert from "node:assert/strict";
import test from "node:test";
import { createTestCodexSdkGateway } from "../fixtures/codex-sdk-fixture.js";
import { createClaudeSdkGateway } from "../../src/modules/agent/claude-sdk-gateway.js";
import { createOpenAiSdkGateway } from "../../src/modules/agent/openai-sdk-gateway.js";

for (const provider of ["codex", "claude", "openai"]) {
  test(`${provider}: SE completes beyond the configured gateway deadline`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const session = createSession(provider, "system_engineer");
    const running = session.execute();
    const signal = await session.started;
    t.mock.timers.tick(7_200_000);
    assert.equal(signal.aborted, false);
    session.complete();
    assert.equal((await running).status, "completed");
    assert.equal(session.closed(), true);
  });

  test(`${provider}: Stop cancels SE after the former deadline`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const session = createSession(provider, "system_engineer");
    const controller = new AbortController();
    const reason = Object.assign(new Error("Owner stopped System Engineer."), { code: "TICKET_STOPPED" });
    const running = session.execute({ abortSignal: controller.signal });
    const signal = await session.started;
    t.mock.timers.tick(7_200_000);
    assert.equal(signal.aborted, false);
    controller.abort(reason);
    await assert.rejects(running, (error) => error === reason);
    assert.equal(signal.reason, reason);
    assert.equal(session.closed(), true);
  });

  test(`${provider}: already stopped SE never starts provider work`, async () => {
    const session = createSession(provider, "system_engineer");
    const reason = Object.assign(new Error("Already stopped."), { code: "TICKET_STOPPED" });
    await assert.rejects(session.execute({ abortSignal: AbortSignal.abort(reason) }), (error) => error === reason);
    assert.equal(session.closed(), true);
  });

  test(`${provider}: non-SE retains timeout despite request role override`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const session = createSession(provider, "coder");
    const running = session.execute({ agent: { agent_id: "timeout-test", role: "system_engineer" } });
    const signal = await session.started;
    t.mock.timers.tick(49);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    await assert.rejects(running, /timed out/);
    assert.equal(signal.aborted, true);
    assert.equal(session.closed(), true);
  });
}

// Supplies authoritative profile roles and controllable provider completions to test real gateway
// cancellation wiring, including provider cleanup, without touching a production SDK session.
function createSession(provider, role) {
  const profile = {
    agent_id: "timeout-test", agent_name: "Timeout Test", role, enabled: true, status: "ready",
    gateway_url: "https://gateway.test/v1", credential_ref: "test", reasoning: { effort: "none" }
  };
  const started = Promise.withResolvers();
  const completion = Promise.withResolvers();
  let closed = false;
  const settings = {
    configuration: { getById: () => profile }, credentialResolver: () => "test-key",
    timeoutMs: 50, terminalOutput: { write() {} }
  };
  // Models an in-flight SDK request that only finishes on provider success or gateway cancellation.
  async function run(signal) {
    signal.throwIfAborted();
    const abort = () => completion.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    started.resolve(signal);
    try { await completion.promise; }
    finally { signal.removeEventListener("abort", abort); }
  }
  let gateway;
  if (provider === "codex") {
    gateway = createTestCodexSdkGateway({
      ...settings,
      CodexClass: class {
        // Exposes the same cancellable stream shape as Codex while recording stream disposal.
        startThread() {
          return {
            id: "timeout-thread",
            runStreamed: async (_prompt, { signal }) => ({
              // Keeps the SDK iterator active until a test completes or cancels the request.
              events: (async function* () {
                try { await run(signal); yield { type: "turn.completed" }; }
                finally { closed = true; }
              })()
            })
          };
        }
      }
    });
  } else if (provider === "claude") {
    gateway = createClaudeSdkGateway({
      ...settings,
      queryFn: ({ options }) => ({
        // Keeps Claude's iterator active with the gateway-provided AbortController.
        async *[Symbol.asyncIterator]() {
          await run(options.abortController.signal);
          yield { type: "result", subtype: "success", result: "Done" };
        },
        close: () => { closed = true; }
      })
    });
  } else {
    gateway = createOpenAiSdkGateway({
      ...settings,
      providerFactory: { createForAgent: async () => ({ profile, provider: { close: () => { closed = true; } } }) },
      AgentClass: class {},
      runner: async (_agent, _prompt, { signal }) => { await run(signal); return { finalOutput: "Done" }; }
    });
  }
  return {
    execute: (options = {}) => gateway.execute({ agentId: profile.agent_id, prompt: "Perform engineering work", correlationId: "TIMEOUT-TEST", ...options }),
    started: started.promise, complete: () => completion.resolve(), closed: () => closed
  };
}
