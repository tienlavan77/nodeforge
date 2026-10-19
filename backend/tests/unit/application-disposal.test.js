// Verifies shared cleanup retains resource-specific shutdown behavior across project lifetimes.
import test from "node:test";
import assert from "node:assert/strict";
import { createApplicationDisposal } from "../../scripts/control-api-application-disposal.mjs";
import { createProjectRuntimeDisposal } from "../../src/modules/projects/project-runtime-disposal.js";

test("resource cleanup shares promises, receivers, synchronous failures and dependency order", async () => {
  const events = [];
  const disposal = createApplicationDisposal();
  const resource = { value: 7, read() { return this.value; }, close() { assert.equal(this, resource); events.push("database"); throw new Error("database failure"); } };
  const handle = disposal.own(resource, "close", 40);
  const secondHandle = disposal.own(resource, "close", 40);
  disposal.own({ stop() { events.push("worker"); } }, "stop", 10);
  disposal.own({ release() { events.push("lock"); } }, "release", 60);
  assert.equal(handle.read(), 7);
  assert.equal(handle.close(), secondHandle.close());
  await assert.rejects(handle.close(), /database failure/);
  const closing = disposal.close();
  assert.equal(closing, disposal.close());
  await assert.rejects(closing, AggregateError);
  assert.deepEqual(events, ["database", "worker", "lock"]);
  await assert.rejects(disposal.close(), AggregateError);
  assert.equal(events.filter((event) => event === "database").length, 1);
});

test("each cleanup failure preserves subsequent disposal and the cached outcome", async () => {
  for (let failure = 0; failure < 6; failure += 1) {
    const disposal = createApplicationDisposal();
    const events = [];
    for (let stage = 0; stage < 6; stage += 1) {
      disposal.own({ close() { events.push(stage); if (stage === failure) throw new Error(`failure ${stage}`); } }, "close", stage);
    }
    await assert.rejects(disposal.close(), (error) => error.errors.length === 1);
    await assert.rejects(disposal.close(), AggregateError);
    assert.deepEqual(events, [0, 1, 2, 3, 4, 5]);
  }
});

test("runtime cleanup proceeds after application failure and invalidates request availability", async () => {
  const disposal = createProjectRuntimeDisposal();
  const events = [];
  const runtime = { close() { events.push("runtime"); throw new Error("runtime failure"); } };
  disposal.registerCleanup(runtime, () => { events.push("application"); throw new Error("application failure"); });
  const closing = disposal.releaseRuntime(runtime);
  assert.equal(disposal.isAvailable(runtime), false);
  assert.equal(disposal.registerCleanup(runtime, () => {}), false);
  assert.equal(closing, disposal.releaseRuntime(runtime));
  await assert.rejects(closing, (error) => error.errors.length === 2);
  await assert.rejects(disposal.releaseRuntime(runtime), AggregateError);
  assert.deepEqual(events, ["application", "runtime"]);
});
