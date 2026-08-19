import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createAgentSession } from "../../src/modules/agent/session.js";
import { createAgentSessionStore } from "../../src/modules/agent/session-store.js";

test("persists RUNNING and PAUSED Agent Sessions across a database restart", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-agent-sessions-"));
  let database = await openIndexDatabase(projectRoot);
  try {
    const store = createAgentSessionStore({ database });
    const running = createSession("AGENT-SESSION-098-running");
    running.start();
    const paused = createSession("AGENT-SESSION-098-paused");
    paused.start();
    paused.pause();
    assert.equal(store.save(running).state, "RUNNING");
    assert.equal(store.save(paused).state, "PAUSED");
    await database.close();

    database = await openIndexDatabase(projectRoot);
    const restartedStore = createAgentSessionStore({ database });
    assert.deepEqual(restartedStore.load(running.id), {
      id: running.id,
      state: "RUNNING",
      created_at: "2026-08-20T01:00:00.000Z",
      updated_at: "2026-08-20T01:00:00.000Z"
    });
    assert.deepEqual(restartedStore.load(paused.id), {
      id: paused.id,
      state: "PAUSED",
      created_at: "2026-08-20T01:00:00.000Z",
      updated_at: "2026-08-20T01:00:00.000Z"
    });
    assert.deepEqual(restartedStore.loadAll().map(({ id, state }) => ({ id, state })), [
      { id: running.id, state: "RUNNING" },
      { id: paused.id, state: "PAUSED" }
    ]);
  } finally {
    await database?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function createSession(id) {
  return createAgentSession({ id, clock: () => new Date("2026-08-20T01:00:00Z") });
}
