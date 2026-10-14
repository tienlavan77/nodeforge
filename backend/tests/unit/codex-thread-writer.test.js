// Verifies session retries preserve history and refuse concurrent Codex writers.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertCodexThreadAvailable } from "../../src/modules/agent/codex-thread-writer.js";
import { createCodexSdkGateway } from "../../src/modules/agent/codex-sdk-gateway.js";

// Models a Codex child without exposing the real process environment or invoking a provider.
function fixture(t, args, home = "/agent-home", writer = false) {
  const root = mkdtempSync(join(tmpdir(), "codex-writer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "42", "fd"), { recursive: true });
  writeFileSync(join(root, "42", "cmdline"), ["/sdk/bin/codex", ...args, ""].join("\0"));
  writeFileSync(join(root, "42", "environ"), `CODEX_HOME=${home}\0`);
  if (writer) symlinkSync("/agent-home/thread-writer-locks/thread-1.lock", join(root, "42", "fd", "9"));
  return root;
}

test("rejects a live resumed writer and permits continuation once it exits", (t) => {
  const root = fixture(t, ["exec", "resume", "thread-1"]);
  assert.throws(() => assertCodexThreadAvailable("/agent-home", "thread-1", root), { code: "EXECUTION_SESSION_BUSY", statusCode: 409 });
  rmSync(join(root, "42"), { recursive: true });
  assert.doesNotThrow(() => assertCodexThreadAvailable("/agent-home", "thread-1", root));
});

test("detects the original runner through its open writer file without resume arguments", (t) => {
  const root = fixture(t, ["exec", "--experimental-json"], "/agent-home", true);
  assert.throws(() => assertCodexThreadAvailable("/agent-home", "thread-1", root), { code: "EXECUTION_SESSION_BUSY" });
});

test("does not block a different agent home or another session", (t) => {
  const root = fixture(t, ["exec", "resume", "thread-1"], "/other-home");
  assert.doesNotThrow(() => assertCodexThreadAvailable("/agent-home", "thread-1", root));
  assert.doesNotThrow(() => assertCodexThreadAvailable("/other-home", "thread-2", root));
});

test("maps the SDK writer race to a recoverable conflict without silently starting a new thread", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "codex-writer-gateway-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let attempts = 0;
  const gateway = createCodexSdkGateway({
    codexHomeRoot: home,
    terminalOutput: { write() {} },
    configuration: { getById: () => ({ agent_id: "writer-test", gateway_url: "https://gateway.test", credential_ref: "test", enabled: true, status: "ready" }) },
    credentialResolver: () => "test-key",
    CodexClass: class {
      resumeThread() {
        attempts++;
        return { runStreamed: async () => { throw new Error("thread-store conflict: thread thread-1 already has an active writer"); } };
      }
      startThread() { assert.fail("Must not replace an occupied session"); }
    }
  });
  await assert.rejects(gateway.execute({ agentId: "writer-test", prompt: "Continue", correlationId: "C", resumeThreadId: "thread-1" }), { code: "EXECUTION_SESSION_BUSY", statusCode: 409 });
  assert.equal(attempts, 1);
});
