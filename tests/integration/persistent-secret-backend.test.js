import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPersistentSecretBackend } from "../../src/modules/agent/persistent-secret-backend.js";

test("encrypts secrets, supports set/get/delete, and reloads after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nodeforge-secrets-")); const filePath = join(dir, "secrets.vault");
  const first = createPersistentSecretBackend({ filePath, encryptionKey: "test-encryption-key" });
  first.set("runtime:builder:key", "super-secret");
  assert.equal(first.get("runtime:builder:key"), "super-secret");
  const raw = await readFile(filePath, "utf8"); assert.equal(raw.includes("super-secret"), false);
  const second = createPersistentSecretBackend({ filePath, encryptionKey: "test-encryption-key" });
  assert.equal(second.get("runtime:builder:key"), "super-secret");
  assert.equal(second.delete("runtime:builder:key"), true); assert.equal(second.get("runtime:builder:key"), undefined);
});

test("handles missing secret and rejects a vault opened with the wrong encryption key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nodeforge-secrets-"));
  const filePath = join(dir, "vault");
  const backend = createPersistentSecretBackend({ filePath, encryptionKey: "key" });
  assert.equal(backend.get("missing"), undefined);
  assert.throws(() => backend.set("x", ""), /non-empty/);
  backend.set("x", "secret");
  const wrongKey = createPersistentSecretBackend({ filePath, encryptionKey: "wrong" });
  assert.throws(() => wrongKey.get("x"), /unavailable/);
});
