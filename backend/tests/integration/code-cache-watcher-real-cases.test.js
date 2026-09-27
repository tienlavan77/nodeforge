// Verifies watcher and indexer processes deliver cache events through the production HTTP route.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Waits for a child process marker without treating transient absence as a failure.
async function waitForFile(path, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { return await readFile(path, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

// Starts a real child and captures its errors for actionable integration failures.
function startChild(fixture, args, env = process.env) {
  const child = spawn(process.execPath, [new URL(fixture, import.meta.url).pathname, ...args], { env, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (chunk) => { child.errorOutput = `${child.errorOutput ?? ""}${chunk}`; });
  return child;
}

// Stops a watcher or API process before removing its project fixture.
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise((resolve) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
  child.kill("SIGTERM");
  await stopped;
}

test("real watcher and indexer invalidate cached paths on rename and delete", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-cache-real-rename-"));
  const ready = join(root, "control-ready"); const watcherReady = join(root, "watcher-ready");
  const result = join(root, "result.json"); const marker = join(root, "event-type");
  let control; let watcher;
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/example.js"), "export const value = 1;\n");
    control = startChild("../fixtures/cache-control-process.mjs", [root, ready, result]);
    const port = await waitForFile(ready);
    watcher = startChild("../fixtures/cache-watcher-process.mjs", [root, `http://127.0.0.1:${port}/forge/v1/stream/events`, watcherReady], { ...process.env, CACHE_TEST_EVENT_MARKER: marker });
    await waitForFile(watcherReady);
    await writeFile(join(root, "src/example.js"), "export const value = 2;\n");
    assert.equal(JSON.parse(await waitForFile(result)).event_type, "watcher.file_modified", watcher.errorOutput);
    await rm(result); await rm(marker);
    await rename(join(root, "src/example.js"), join(root, "src/renamed.js"));
    const renamed = JSON.parse(await waitForFile(result));
    assert.equal(renamed.event_type, "watcher.file_renamed", watcher.errorOutput);
    assert.equal(renamed.old.error_code, "ENOENT");
    assert.match(renamed.content, /value = 2/);
    await rm(result); await rm(marker);
    await unlink(join(root, "src/renamed.js"));
    const deleted = JSON.parse(await waitForFile(result));
    assert.equal(deleted.event_type, "watcher.file_deleted", watcher.errorOutput);
    assert.equal(deleted.error_code, "ENOENT");
  } finally { await stopChild(watcher); await stopChild(control); await rm(root, { recursive: true, force: true }); }
});

test("real watcher mismatch invalidates cache and another project cannot refresh it", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-cache-real-isolation-"));
  const ready = join(root, "control-ready"); const result = join(root, "result.json");
  let control; let watcher;
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/example.js"), "export const value = 1;\n");
    control = startChild("../fixtures/cache-control-process.mjs", [root, ready, result]);
    const port = await waitForFile(ready);
    const url = `http://127.0.0.1:${port}/forge/v1/stream/events`;
    watcher = startChild("../fixtures/cache-watcher-process.mjs", [root, url, join(root, "other-ready")], { ...process.env, CACHE_TEST_PROJECT_ID: "OTHER" });
    await waitForFile(join(root, "other-ready"));
    await writeFile(join(root, "src/example.js"), "export const value = 2;\n");
    const isolated = JSON.parse(await waitForFile(result));
    assert.equal(isolated.event_type, "watcher.file_modified", watcher.errorOutput);
    assert.match(isolated.content, /value = 1/);
    assert.equal(isolated.cache.status, "hit");
    await stopChild(watcher); watcher = null; await rm(result);
    watcher = startChild("../fixtures/cache-watcher-process.mjs", [root, url, join(root, "mismatch-ready")], { ...process.env, CACHE_TEST_SHA_OVERRIDE: `sha256:${"0".repeat(64)}` });
    await waitForFile(join(root, "mismatch-ready"));
    await writeFile(join(root, "src/example.js"), "export const value = 3;\n");
    const mismatch = JSON.parse(await waitForFile(result));
    assert.match(mismatch.content, /value = 3/, watcher.errorOutput);
    assert.equal(mismatch.cache.status, "miss");
  } finally { await stopChild(watcher); await stopChild(control); await rm(root, { recursive: true, force: true }); }
});

test("real watcher serves the latest source when a second write races slow indexing", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-cache-real-race-"));
  const ready = join(root, "control-ready"); const result = join(root, "result.json");
  const marker = join(root, "before-index");
  let control; let watcher;
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/example.js"), "export const value = 1;\n");
    control = startChild("../fixtures/cache-control-process.mjs", [root, ready, result]);
    const port = await waitForFile(ready);
    watcher = startChild("../fixtures/cache-watcher-process.mjs", [root, `http://127.0.0.1:${port}/forge/v1/stream/events`, join(root, "watcher-ready")], { ...process.env, CACHE_TEST_INDEX_DELAY_MS: "500", CACHE_TEST_PRE_INDEX_MARKER: marker });
    await waitForFile(join(root, "watcher-ready"));
    await writeFile(join(root, "src/example.js"), "export const value = 2;\n");
    await waitForFile(marker);
    await writeFile(join(root, "src/example.js"), "export const value = 3;\n");
    const observed = JSON.parse(await waitForFile(result));
    assert.match(observed.content, /value = 3/, watcher.errorOutput);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const final = JSON.parse(await readFile(result, "utf8"));
    const expectedSha = `sha256:${createHash("sha256").update("export const value = 3;\n").digest("hex")}`;
    assert.equal(final.content, "export const value = 3;\n");
    assert.equal(final.content_sha256, expectedSha);
    assert.equal(final.event_sha256?.replace(/^sha256:/, ""), expectedSha.slice(7));
    assert.equal(final.cache.status, "hit");
    assert.equal(final.cache_event_status, "refreshed");
    assert.equal(final.cache_stats.entries, 1);
  } finally { await stopChild(watcher); await stopChild(control); await rm(root, { recursive: true, force: true }); }
});
