import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createAgentSession } from "../../src/modules/agent/session.js";
import { createAgentSessionStore } from "../../src/modules/agent/session-store.js";
import { createRuntimeRecovery } from "../../src/modules/recovery/runtime-recovery.js";

test("recovers RUNNING and PAUSED sessions but skips terminal sessions after restart", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-recovery-"));
  let database = await openIndexDatabase(projectRoot);
  try {
    const store = createAgentSessionStore({ database });
    for (const state of ["RUNNING", "PAUSED", "COMPLETED", "FAILED"]) {
      store.save(sessionInState(`AGENT-SESSION-099-${state}`, state));
    }
    await database.close();

    database = await openIndexDatabase(projectRoot);
    const recovery = createRuntimeRecovery({ sessionStore: createAgentSessionStore({ database }) });
    assert.deepEqual(recovery.recover().recoveredSessions.map(({ id, state }) => ({ id, state })), [
      { id: "AGENT-SESSION-099-RUNNING", state: "RUNNING" },
      { id: "AGENT-SESSION-099-PAUSED", state: "PAUSED" }
    ]);
  } finally {
    await database?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function sessionInState(id, state) {
  const session = createAgentSession({ id, clock: () => new Date("2026-08-20T02:00:00Z") });
  if (state === "RUNNING") session.start();
  if (state === "PAUSED") {
    session.start();
    session.pause();
  }
  if (state === "COMPLETED") {
    session.start();
    session.complete();
  }
  if (state === "FAILED") session.fail(new Error("failure"));
  return session;
}
