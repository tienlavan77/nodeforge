// Verifies a watcher process refreshes cached code through the existing Control API event route.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rename, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createCodeCacheService } from "../../src/modules/context/code-cache-service.js";
import { createWatcherCacheEvents } from "../../src/modules/context/watcher-cache-events.js";
import { createForgeV1Router } from "../../src/transport/http/forge-v1-router.js";
import { createHttpApi } from "../../src/transport/http/server.js";
import { createReadCodeTool } from "../../src/tools/read-code.js";

// Sends one watcher event over HTTP from a separate Node process.
function postFromWatcher(url, event) {
  return new Promise((resolve, reject) => {
    const script = "fetch(process.argv[1], {method:'POST',headers:{'content-type':'application/json'},body:process.argv[2]}).then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(2))";
    const child = spawn(process.execPath, ["-e", script, url, JSON.stringify(event)], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Watcher POST exited ${code}`)));
  });
}

// Starts a real Control API child with its own cache and waits for its ready file.
function startControlChild(root, ready, result) {
  const fixture = new URL("../fixtures/cache-control-process.mjs", import.meta.url).pathname;
  const child = spawn(process.execPath, [fixture, root, ready, result], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => { child.__errorOutput = `${child.__errorOutput ?? ""}${chunk}`; });
  child.on("exit", (code, signal) => { child.__exitState = `${code ?? ""}/${signal ?? ""}`; });
  return child;
}

async function waitForFile(path, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { return await (await import("node:fs/promises")).readFile(path, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test("separate watcher POST refreshes live source and marks the older index stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-cache-http-"));
  const path = "src/example.js";
  await mkdir(join(root, "src"));
  const original = "export function example() {\n return 1;\n}\n";
  await writeFile(join(root, path), original);
  const originalSha = `sha256:${createHash("sha256").update(original).digest("hex")}`;
  const fileService = createFileService({ projectRoot: root });
  const codeCache = createCodeCacheService({ projectId: "P", fileService, codeSearch: { fileMetadata: () => ({ sha256: originalSha, symbols: [], graph: {} }) } });
  const router = createForgeV1Router({ projectStream: { ingest: () => ({ accepted: true }) }, onWatcherEvent: createWatcherCacheEvents({ projectId: "P", codeCache }) });
  const server = createHttpApi({ forgeV1Router: router }).createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/forge/v1/stream/events`;
  try {
    assert.equal((await codeCache.read({ path })).cache.status, "miss");
    assert.equal((await codeCache.read({ path })).cache.status, "hit");
    await writeFile(join(root, path), "// shifted\nexport function example() {\n return 2;\n}\n");
    await postFromWatcher(url, { project_id: "P", event_id: "EVT-CHANGE", type: "watcher.file_modified", payload: { path } });
    const changed = await codeCache.read({ path });
    assert.match(changed.content, /return 2/);
    assert.equal(changed.index_status, "stale");
    assert.equal(changed.cache.status, "hit");
    const code = await createReadCodeTool({ fileService, codeCache }).execute({ kind: "symbol", path, symbol: "example", start_line: 1, end_line: 3, max_chars: 1000 }, { task_id: "CACHE-STALE-SYMBOL", capabilities: ["read_code"], allowed_file_paths: [path], allowed_symbols: [{ path, name: "example", start_line: 1, end_line: 3 }] });
    assert.match(code.content, /return 2/);
    assert.equal(code.start_line, 2);
    await unlink(join(root, path));
    await postFromWatcher(url, { project_id: "P", event_id: "EVT-DELETE", type: "watcher.file_deleted", payload: { path } });
    await assert.rejects(codeCache.read({ path }), { code: "ENOENT" });
  } finally {
    codeCache.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("real Control API child receives a watcher POST from a separate watcher child", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-cache-two-process-"));
  const ready = join(root, "ready"); const result = join(root, "result.json"); const path = "src/example.js";
  let control;
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, path), "export const value = 1;\n");
    control = startControlChild(root, ready, result);
    let port;
    try { port = await waitForFile(ready); }
    catch (error) { error.message += `\ncontrol child: ${control.__errorOutput ?? ""} exit=${control.__exitState ?? "running"}`; throw error; }
    await writeFile(join(root, path), "export const value = 2;\n");
    await postFromWatcher(`http://127.0.0.1:${port}/forge/v1/stream/events`, { project_id: "P", event_id: "REAL-1", type: "watcher.file_modified", payload: { path } });
    const observed = JSON.parse(await waitForFile(result));
    assert.match(observed.content, /value = 2/);
    assert.equal(observed.cache.status, "hit");
  } finally {
    if (control && control.exitCode === null) {
      const stopped = new Promise((resolve) => control.once("exit", resolve));
      control.kill("SIGTERM");
      await stopped;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("real watcher and indexer process refresh the Control API child cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-cache-indexed-watcher-"));
  const controlReady = join(root, "control-ready"); const watcherReady = join(root, "watcher-ready");
  const result = join(root, "result.json"); const path = "src/example.js";
  let control; let watcher; let restarted;
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, path), "export const value = 1;\n");
    control = startControlChild(root, controlReady, result);
    const port = await waitForFile(controlReady);
    watcher = spawn(process.execPath, [new URL("../fixtures/cache-watcher-process.mjs", import.meta.url).pathname, root, `http://127.0.0.1:${port}/forge/v1/stream/events`, watcherReady], { stdio: ["ignore", "ignore", "pipe"] });
    watcher.stderr.on("data", (chunk) => { watcher.__errorOutput = `${watcher.__errorOutput ?? ""}${chunk}`; });
    try { await waitForFile(watcherReady, 10000); }
    catch (error) { error.message += `\nwatcher: ${watcher.__errorOutput ?? ""}`; throw error; }
    await writeFile(join(root, path), "export const value = 3;\n");
    const observed = JSON.parse(await waitForFile(result, 10000));
    assert.match(observed.content, /value = 3/, watcher.__errorOutput);
    assert.equal(observed.cache.status, "hit");
    const stopped = new Promise((resolve) => control.once("exit", resolve));
    control.kill("SIGTERM"); await stopped;
    restarted = startControlChild(root, join(root, "restart-ready"), join(root, "restart-result.json"));
    await waitForFile(join(root, "restart-ready"));
    assert.equal(await waitForFile(join(root, "restart-ready.cache-status")), "miss");
  } finally {
    for (const child of [watcher, control, restarted]) if (child && child.exitCode === null) {
      const stopped = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGTERM"); await stopped;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("two-process HTTP events handle checksum mismatch, project isolation, rename and delete", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-cache-http-cases-"));
  const ready = join(root, "ready"); const result = join(root, "result.json");
  const oldPath = "src/example.js"; const newPath = "src/renamed.js";
  let control;
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, oldPath), "export const value = 1;\n");
    control = startControlChild(root, ready, result);
    const port = await waitForFile(ready);
    const url = `http://127.0.0.1:${port}/forge/v1/stream/events`;
    await writeFile(join(root, oldPath), "export const value = 2;\n");
    await postFromWatcher(url, { project_id: "P", event_id: "MISMATCH-1", type: "watcher.file_modified", payload: { path: oldPath, sha256: `sha256:${"0".repeat(64)}` } });
    const mismatch = JSON.parse(await waitForFile(result));
    assert.match(mismatch.content, /value = 2/);
    assert.equal(mismatch.cache.status, "miss");
    await rm(result);
    await writeFile(join(root, oldPath), "export const value = 3;\n");
    await postFromWatcher(url, { project_id: "OTHER", event_id: "OTHER-1", type: "watcher.file_modified", payload: { path: oldPath } });
    const isolated = JSON.parse(await waitForFile(result));
    assert.match(isolated.content, /value = 2/);
    assert.equal(isolated.cache.status, "hit");
    await rm(result);
    await rename(join(root, oldPath), join(root, newPath));
    await postFromWatcher(url, { project_id: "P", event_id: "RENAME-1", type: "watcher.file_renamed", payload: { path: newPath, old_path: oldPath } });
    const renamed = JSON.parse(await waitForFile(result));
    assert.match(renamed.content, /value = 3/);
    assert.equal(renamed.cache.status, "miss");
    assert.equal(renamed.old.error_code, "ENOENT");
    await rm(result);
    await unlink(join(root, newPath));
    await postFromWatcher(url, { project_id: "P", event_id: "DELETE-1", type: "watcher.file_deleted", payload: { path: newPath } });
    const deleted = JSON.parse(await waitForFile(result));
    assert.equal(deleted.error_code, "ENOENT");
  } finally {
    if (control && control.exitCode === null) {
      const stopped = new Promise((resolve) => control.once("exit", resolve)); control.kill("SIGTERM"); await stopped;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("slow indexing still completes when the Control API is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-cache-watcher-offline-"));
  const ready = join(root, "watcher-ready"); const marker = join(root, ".forge", "index-complete");
  let watcher;
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/example.js"), "export const value = 1;\n");
    watcher = spawn(process.execPath, [new URL("../fixtures/cache-watcher-process.mjs", import.meta.url).pathname, root, "http://127.0.0.1:1/forge/v1/stream/events", ready], { env: { ...process.env, CACHE_TEST_INDEX_DELAY_MS: "250", CACHE_TEST_INDEX_MARKER: marker }, stdio: ["ignore", "ignore", "pipe"] });
    watcher.stderr.on("data", (chunk) => { watcher.__errorOutput = `${watcher.__errorOutput ?? ""}${chunk}`; });
    await waitForFile(ready, 10000);
    await writeFile(join(root, "src/example.js"), "export const value = 4;\n");
    assert.equal(await waitForFile(marker, 5000), "indexed", watcher.__errorOutput);
  } finally {
    if (watcher && watcher.exitCode === null) {
      const stopped = new Promise((resolve) => watcher.once("exit", resolve)); watcher.kill("SIGTERM"); await stopped;
    }
    await rm(root, { recursive: true, force: true });
  }
});
