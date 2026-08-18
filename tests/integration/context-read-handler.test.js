import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createEnvelopeValidator } from "../../src/modules/agents/agent-process.js";
import { createContextReadHandler } from "../../src/modules/agents/context-read-handler.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createIncrementalIndexer } from "../../src/modules/index/incremental-indexer.js";

const sampleProject = fileURLToPath(new URL("../fixtures/sample-project", import.meta.url));

test("routes context.read_file through Node's Code Index and returns a context pack to the Agent", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-context-read-"));
  let database;
  let handler;

  try {
    await cp(sampleProject, projectRoot, { recursive: true });
    database = await openIndexDatabase(projectRoot);
    const indexer = createIncrementalIndexer({ database, projectRoot });
    await indexer.handle({ type: "watcher.file_created", payload: { path: "src/auth.js" } });

    const agent = new EventEmitter();
    const responses = [];
    agent.sendEvent = async (envelope) => responses.push(envelope);
    handler = createContextReadHandler({
      agent,
      database,
      projectId: "PROJECT-context-read",
      projectRoot,
      createEventId: () => "EVT-NODE-CONTEXT-001",
      clock: () => new Date("2026-08-18T09:00:01Z")
    });

    agent.emit("message", {
      protocol_version: "1.2.0",
      message_id: "MSG-AGENT-CONTEXT-READ-001",
      sender: { id: "AGENT-REVIEWER-001", type: "ai", role: "reviewer" },
      message: {
        type: "context.read_file",
        request_id: "REQ-CONTEXT-READ-001",
        project_id: "PROJECT-context-read",
        session_id: "SESSION-REVIEWER-001",
        timestamp: "2026-08-18T09:00:00Z",
        payload: { path: "src/auth.js" }
      }
    });
    await waitFor(() => responses.length === 1);

    const response = responses[0];
    assert.equal(createEnvelopeValidator()(response), true);
    assert.equal(response.message.type, "context.pack_generated");
    assert.equal(response.message.request_id, "REQ-CONTEXT-READ-001");
    assert.equal(response.message.payload.path, "src/auth.js");
    assert.match(response.message.payload.content, /export function login/);
    assert.deepEqual(response.message.payload.symbols.map(({ name }) => name), ["login"]);
    assert.equal(response.message.payload.file.file_id, database.all("SELECT file_id FROM files WHERE path = ?", ["src/auth.js"])[0].file_id);
  } finally {
    handler?.close();
    await database?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the context handler response.");
}
