import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createAgentProcess } from "../../src/modules/agents/agent-process.js";
import { linkAgentSessions } from "../../src/modules/agents/agent-session-link.js";
import { createSessionStore } from "../../src/modules/projects/session-store.js";

const fixture = fileURLToPath(new URL("../fixtures/agent-session-fixture.js", import.meta.url));

test("links sessions.start and sessions.stop from an agent process to persisted session state", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-agent-session-link-"));
  let database;
  let agent;
  let linkage;

  try {
    database = await openIndexDatabase(projectRoot);
    const store = createSessionStore({
      database,
      projectId: "PROJECT-agent-session-test",
      createId: () => "SESSION-agent-link-001",
      clock: () => new Date("2026-08-17T11:00:00Z")
    });
    agent = createAgentProcess({ command: process.execPath, args: [fixture] });
    linkage = linkAgentSessions({ agent, sessionStore: store });

    const startedPromise = once(linkage, "started").then(([session]) => session);
    const stoppedPromise = once(linkage, "stopped").then(([session]) => session);
    const started = await startedPromise;
    const stopped = await stoppedPromise;

    assert.deepEqual(started.agents, ["AGENT-SESSION-FIXTURE-001"]);
    assert.deepEqual(started.capability_scopes, { context: [{ resource: "broker", actions: ["request"] }] });
    assert.equal(stopped.id, started.id);
    assert.equal(stopped.status, "completed");
    await once(agent.child, "exit");

    await database.close();
    database = await openIndexDatabase(projectRoot);
    const reopenedStore = createSessionStore({ database, projectId: "PROJECT-agent-session-test" });
    assert.deepEqual(reopenedStore.get(started.id), stopped);
  } finally {
    linkage?.close();
    agent?.close();
    if (agent && !agent.child.killed && agent.child.exitCode === null) agent.child.kill();
    await database?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
