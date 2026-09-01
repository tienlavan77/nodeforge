import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";

export function createPersistentSecretBackend({ filePath, encryptionKey, keychainService = "nodeforge-secret-key", fileService } = {}) {
  if (typeof filePath !== "string" || !filePath) throw new ConfigurationError("Persistent Secret Backend requires a file path.");
  const key = normalizeKey(encryptionKey ?? loadKeychainKey(keychainService));
  let records = load();
  return Object.freeze({ set, get, delete: remove, reload });

  function set(secretRef, secret) {
    assertRef(secretRef);
    if (typeof secret !== "string" || !secret) throw new ConfigurationError("Secret value must be non-empty.");
    records[secretRef] = encrypt(secret);
    persist();
  }
  function get(secretRef) { assertRef(secretRef); const record = records[secretRef]; return record ? decrypt(record) : undefined; }
  function remove(secretRef) { assertRef(secretRef); if (records[secretRef]) { delete records[secretRef]; persist(); return true; } return false; }
  function reload() { records = load(); return Object.keys(records); }
  function load() {
    if (!existsSync(filePath)) return {};
    try { const parsed = JSON.parse(readFileSync(filePath, "utf8")); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("vault must be an object"); return parsed; }
    catch (error) { throw new ConfigurationError(`Invalid persistent secret vault: ${error.message}`); }
  }
  function persist() {
    if (fileService?.atomicWriteSync) {
      const relative = filePath.startsWith(`${process.cwd()}/`) ? filePath.slice(process.cwd().length + 1) : filePath;
      fileService.atomicWriteSync({ path: relative, content: `${JSON.stringify(records)}\n`, mode: 0o600 });
      return;
    }
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = `${filePath}.tmp`;
    writeFileSync(temp, `${JSON.stringify(records)}\n`, { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, filePath);
  }
  function encrypt(value) {
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  }
  function decrypt(record) {
    try { const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64")); decipher.setAuthTag(Buffer.from(record.tag, "base64")); return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8"); }
    catch { throw new ConfigurationError("Persistent secret is unavailable or invalid."); }
  }
}

function normalizeKey(value) {
  if (typeof value !== "string" || !value) throw new ConfigurationError("Persistent Secret Backend requires an encryption key.");
  return createHash("sha256").update(value).digest();
}
function loadKeychainKey(service) {
  if (process.platform !== "darwin") throw new ConfigurationError("Secure OS keychain is unavailable; provide NODE_SECRET_ENCRYPTION_KEY for local development.");
  try { return execFileSync("security", ["find-generic-password", "-s", service, "-w"], { encoding: "utf8" }).trim(); }
  catch { const value = randomBytes(32).toString("base64"); execFileSync("security", ["add-generic-password", "-a", "nodeforge", "-s", service, "-w", value, "-U"], { stdio: "ignore" }); return value; }
}
function assertRef(value) { if (typeof value !== "string" || !value) throw new ConfigurationError("Secret reference is required."); }
