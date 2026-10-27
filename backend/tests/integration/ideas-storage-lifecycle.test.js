// Exercises Ideas through actual project runtime ownership, independently of panel or
// conversation clients. Closing connections and restarting services must preserve the notebook.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProjectRuntime } from "../../src/modules/projects/project-runtime.js";

/** Starts a real project runtime with local deterministic embeddings and no external service. */
function open(projectRoot, projectId) {
  return startProjectRuntime({
    projectRoot, projectId,
    embeddingProvider: {
      /** Supplies deterministic vectors for any indexed fixture symbols. */
      async embed() { return [1, 0, 0]; },
      /** Completes provider teardown without network resources. */
      async close() {}
    }
  });
}

test("Ideas survive panel disconnect, runtime closure and backend-style restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ideas-lifecycle-"));
  let runtime;
  try {
    runtime = await open(root, "project-a");
    assert.equal(runtime.controlDb.databasePath, join(root, ".forge", "runtime", "control.db"));
    assert.notEqual(runtime.controlDb.databasePath, runtime.database.databasePath);
    assert.equal(runtime.database.all("SELECT name FROM sqlite_master WHERE name = 'ideas'").length, 0);
    const idea = runtime.ideas.create({ content: "persist across clients" });
    const response = new EventEmitter();
    response.write = () => true;
    response.writeHead = () => {};
    response.end = () => {};
    const client = runtime.connect({ requestedProjectId: "project-a", response });
    client.close();
    assert.equal(runtime.ideas.get(idea.id).content, idea.content);
    assert.equal(runtime.ideas.list()[0].id, idea.id);
    await runtime.close();
    await runtime.close();
    assert.throws(() => runtime.ideas.list(), /closed/);
    runtime = await open(root, "project-a");
    assert.deepEqual(runtime.ideas.get(idea.id), idea);
    await runtime.close();
    runtime = await open(root, "project-b");
    assert.equal(runtime.ideas.get(idea.id), undefined);
    assert.deepEqual(runtime.ideas.list(), []);
    await runtime.close();
    runtime = await open(root, "project-a");
    assert.deepEqual(runtime.ideas.get(idea.id), idea);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
