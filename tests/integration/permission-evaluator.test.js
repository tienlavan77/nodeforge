import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ConfigurationError } from "../../src/shared/errors.js";
import { createPermissionEvaluator } from "../../src/modules/rules/permission-evaluator.js";

const projectId = "PROJECT-permissions";

test("allows a role to use a permitted path and access", () => {
  const { evaluator } = createEvaluator();

  assert.deepEqual(evaluator.evaluate({ role: "builder", path: "src/auth.js", access: "write" }), {
    allowed: true,
    permission_id: "PERM-source-write",
    reason: "allowed"
  });
});

test("denies a protected path and publishes rules.permission_denied before the action runs", async () => {
  const { evaluator, bus } = createEvaluator();
  const events = [];
  bus.on("event", (event) => events.push(event));
  let executed = false;

  const result = await evaluator.execute({ role: "builder", path: ".forge/runtime/index.db", access: "write" }, async () => {
    executed = true;
  });

  assert.equal(executed, false);
  assert.deepEqual(result, { allowed: false, permission_id: "PERM-forge-deny", reason: "Node-owned state", executed: false });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "rules.permission_denied");
  assert.deepEqual(events[0].payload, { role: "builder", path: ".forge/runtime/index.db", access: "write", reason: "Node-owned state", permission_id: "PERM-forge-deny" });
});

test("uses priority to resolve allow and deny conflicts", () => {
  const { evaluator } = createEvaluator([
    permission({ id: "PERM-low-deny", path: "src/private/**", access: ["read"], effect: "deny", priority: 100 }),
    permission({ id: "PERM-high-allow", path: "src/private/**", access: ["read"], effect: "allow", priority: 900 })
  ]);

  assert.deepEqual(evaluator.evaluate({ role: "builder", path: "src/private/token.js", access: "read" }), {
    allowed: true,
    permission_id: "PERM-high-allow",
    reason: "allowed"
  });
});

test("defaults to deny for glob and access mismatches, while allowed actions run", async () => {
  const { evaluator } = createEvaluator();

  assert.deepEqual(evaluator.evaluate({ role: "builder", path: "docs/guide.md", access: "write" }), { allowed: false, reason: "no_matching_permission" });
  assert.deepEqual(evaluator.evaluate({ role: "builder", path: "src/auth.js", access: "execute" }), { allowed: false, reason: "no_matching_permission" });
  const result = await evaluator.execute({ role: "builder", path: "src/auth.js", access: "write" }, async () => "written");
  assert.deepEqual(result, { allowed: true, permission_id: "PERM-source-write", reason: "allowed", executed: true, result: "written" });
});

test("rejects invalid action role or access values", () => {
  const { evaluator } = createEvaluator();

  assert.throws(() => evaluator.evaluate({ role: "operator", path: "src/auth.js", access: "read" }), ConfigurationError);
  assert.throws(() => evaluator.evaluate({ role: "builder", path: "src/auth.js", access: "chmod" }), ConfigurationError);
});

function createEvaluator(extraPermissions = []) {
  const bus = new EventEmitter();
  return {
    bus,
    evaluator: createPermissionEvaluator({
      permissions: [
        permission({ id: "PERM-forge-deny", path: ".forge/**", access: ["read", "write"], effect: "deny", priority: 1000, reason: "Node-owned state" }),
        permission({ id: "PERM-source-write", path: "src/**", access: ["read", "write", "create"], effect: "allow", priority: 100 }),
        ...extraPermissions
      ],
      projectId,
      internalBus: bus,
      createEventId: () => "EVT-permission-denied",
      clock: () => new Date("2026-08-18T09:00:00Z")
    })
  };
}

function permission({ id, path, access, effect, priority, reason }) {
  return { id, role: "builder", path, access, effect, priority, ...(reason ? { reason } : {}) };
}
