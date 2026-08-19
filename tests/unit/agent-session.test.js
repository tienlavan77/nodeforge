import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_SESSION_STATES, createAgentSession } from "../../src/modules/agent/session.js";

test("runs the valid Agent Session lifecycle", () => {
  const session = createAgentSession();
  assert.equal(session.getState(), AGENT_SESSION_STATES.CREATED);
  assert.equal(session.start(), AGENT_SESSION_STATES.RUNNING);
  assert.equal(session.pause(), AGENT_SESSION_STATES.PAUSED);
  assert.equal(session.resume(), AGENT_SESSION_STATES.RUNNING);
  assert.equal(session.complete(), AGENT_SESSION_STATES.COMPLETED);
  assert.equal(session.getState(), AGENT_SESSION_STATES.COMPLETED);
});

test("can fail directly from CREATED and from RUNNING", () => {
  const created = createAgentSession();
  assert.equal(created.fail(new Error("startup failed")), AGENT_SESSION_STATES.FAILED);
  assert.equal(created.getState(), AGENT_SESSION_STATES.FAILED);

  const running = createAgentSession();
  running.start();
  assert.equal(running.fail("runtime failed"), AGENT_SESSION_STATES.FAILED);
  assert.equal(running.getState(), AGENT_SESSION_STATES.FAILED);
});

test("rejects invalid transitions and missing failure errors", () => {
  const session = createAgentSession();
  assert.throws(() => session.pause(), /Invalid Agent Session transition/);
  assert.throws(() => session.fail(), /failure requires an error/);
  session.start();
  session.complete();
  assert.throws(() => session.resume(), /Invalid Agent Session transition/);
  assert.throws(() => session.complete(), /Invalid Agent Session transition/);
});
