// Exercises the backend workspace boundary against cached routers and stream handles. Membership
// alone cannot authorize JSON, project SSE or conversation SSE after runtime readiness is revoked.
import test from "node:test";
import assert from "node:assert/strict";
import { createForgeV1Router } from "../../src/transport/http/forge-v1-router.js";
import { createProjectRuntimeDisposal } from "../../src/modules/projects/project-runtime-disposal.js";
import { startRuntimeWithProgress } from "../../src/modules/projects/project-runtime-progress.js";
import { createProjectApplicationRegistry } from "../../scripts/control-api-project-applications.mjs";
import { fixture } from "./multi-project-lifecycle-support.js";

test("cached JSON and both SSE handles recheck readiness", async () => {
  let ready = true;
  let connections = 0;
  const stream = { connect() { connections += 1; } };
  const router = createForgeV1Router({ projectStream: stream, conversationStream: stream,
    assertAdmission() { if (!ready) throw Object.assign(new Error("unavailable"), { code: "PROJECT_NOT_FOUND" }); }
  });
  const url = new URL("http://localhost/projects/PROJECT-A/stream");
  const streams = await router.resolveStreams({ method: "GET", url, parts: ["projects", "PROJECT-A", "stream"] });
  streams.projectStream.connect({});
  assert.equal(connections, 1);
  ready = false;
  await assert.rejects(router.route("GET", new URL("http://localhost/projects/PROJECT-A"), { headers: {} }), { code: "PROJECT_NOT_FOUND" });
  await assert.rejects(router.resolveStreams({ method: "GET", url, parts: ["projects", "PROJECT-A", "stream"] }), { code: "PROJECT_NOT_FOUND" });
  assert.throws(() => streams.projectStream.connect({}), { code: "PROJECT_NOT_FOUND" });
  assert.throws(() => streams.conversationStream.connect({}), { code: "PROJECT_NOT_FOUND" });
  assert.equal(connections, 1);
});

test("disposal revokes admission synchronously and failed indexing is never admitted", async () => {
  const disposal = createProjectRuntimeDisposal();
  let closed = false;
  const runtime = { close() { closed = true; }, status: () => ({ closed }) };
  assert.equal(disposal.isAvailable(runtime), true);
  const release = disposal.releaseRuntime(runtime);
  assert.equal(disposal.isAvailable(runtime), false);
  await release;
  assert.equal(closed, true);
  let rolledBack = false;
  await assert.rejects(startRuntimeWithProgress(async () => ({ close() { rolledBack = true; } }), {
    progress: { snapshot: () => ({ checkpoint: { version: 1 }, status: "failed" }), fail(error) { assert.equal(error.code, "index_failed"); } }
  }), { code: "index_failed" });
  assert.equal(rolledBack, true);
  assert.equal(disposal.isAvailable({ status: () => ({ progress: { status: "failed" } }) }), false);
});

test("readiness lost during asynchronous composition disposes the pending application", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  let ready = true;
  let complete;
  let started;
  const composing = new Promise((resolve) => { started = resolve; });
  const runtime = { projectId: "PROJECT-A", projectRoot: f.roots[0], status: () => ({ closed: !ready }) };
  const lifecycle = {
    list: () => ready ? [{ root: f.roots[0], projectId: "PROJECT-A" }] : [],
    get: async () => ready ? runtime : undefined,
    registerCleanup: () => true
  };
  let stopped = 0;
  const registry = createProjectApplicationRegistry({
    projectLifecycle: lifecycle, defaultRoot: f.roots[1],
    defaultApplication: { storage: {}, services: { projectId: "PROJECT-B" } },
    createStorage: async () => ({}),
    createApplication: async () => {
      started();
      await new Promise((resolve) => { complete = resolve; });
      return { services: { projectId: "PROJECT-A" }, workers: [{ stop() { stopped += 1; } }] };
    }
  });
  t.after(() => registry.close());
  const pending = registry.resolve("PROJECT-A");
  await composing;
  ready = false;
  complete();
  assert.equal(await pending, undefined);
  assert.equal(stopped, 1);
  assert.equal(await registry.resolve("PROJECT-A"), undefined);
});
