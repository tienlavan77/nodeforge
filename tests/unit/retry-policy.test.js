import assert from "node:assert/strict";
import test from "node:test";

import { createRetryPolicy } from "../../src/modules/recovery/retry-policy.js";

test("retries a transient failure until the operation succeeds", async () => {
  const attempts = [];
  const result = await createRetryPolicy({ maxAttempts: 3 }).execute(async ({ attempt }) => {
    attempts.push(attempt);
    if (attempt === 1) throw new Error("temporary");
    return "ok";
  });

  assert.equal(result, "ok");
  assert.deepEqual(attempts, [1, 2]);
});

test("respects maxAttempts and throws the last error", async () => {
  const errors = [new Error("first"), new Error("second"), new Error("last")];
  const attempts = [];
  await assert.rejects(
    () => createRetryPolicy({ maxAttempts: 3 }).execute(({ attempt }) => {
      attempts.push(attempt);
      throw errors[attempt - 1];
    }),
    (error) => error === errors[2]
  );
  assert.deepEqual(attempts, [1, 2, 3]);
});

test("supports a per-operation attempt limit", async () => {
  let attempts = 0;
  await assert.rejects(
    () => createRetryPolicy({ maxAttempts: 5 }).execute(() => {
      attempts += 1;
      throw new Error("failure");
    }, { maxAttempts: 2 }),
    /failure/
  );
  assert.equal(attempts, 2);
});
