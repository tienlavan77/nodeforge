#!/usr/bin/env node
// CLI entry for index rebuild and project file watching.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { rebuildIndex } from "../../modules/index/index-rebuild.js";
import { startProjectWatch } from "../../modules/watcher/watch-project.js";
import { openIndexDatabase } from "../../infrastructure/sqlite/index-database.js";
import { createEmbeddingJobStore } from "../../modules/index/embedding-job-store.js";
import { createEmbeddingStore } from "../../modules/index/embedding-store.js";
import { createEmbeddingWorker } from "../../modules/index/embedding-worker.js";
import { createOllamaEmbeddingProvider } from "../../modules/index/ollama-embedding-provider.js";

// Runs the Forge CLI for index rebuild or file watching.
// Parses and executes thin CLI project lifecycle subcommands (forge project add/remove/list) over the Control API.
async function runProjectCli(args, { env, fetchImpl, stdout, stderr }) {
  const action = args[1];
  if (action !== "add" && action !== "remove" && action !== "list") return null;
  let serverUrl = env?.NODEFORGE_CONTROL_API_URL ? String(env.NODEFORGE_CONTROL_API_URL).trim() : "";
  const positionals = [];
  for (let i = 2; i < args.length; i += 1) {
    if (args[i] === "--server") {
      if (i + 1 >= args.length || !String(args[i + 1]).trim()) {
        stderr.write("Missing value for --server.\n");
        return 1;
      }
      serverUrl = String(args[i + 1]).trim();
      i += 1;
    } else if (String(args[i]).startsWith("--")) {
      stderr.write(`Unknown option: ${args[i]}\n`);
      return 1;
    } else {
      positionals.push(args[i]);
    }
  }
  if (!serverUrl) {
    stderr.write("Control API server URL is required via --server <url> or NODEFORGE_CONTROL_API_URL.\n");
    return 1;
  }
  let baseUrl;
  try {
    baseUrl = new URL(serverUrl);
  } catch (error) {
    stderr.write(`Invalid Control API server URL: ${error.message}\n`);
    return 1;
  }
  if (action === "list") {
    if (positionals.length !== 0) {
      stderr.write("Usage: forge project list [--server <url>]\n");
      return 1;
    }
    return invokeLifecycleEndpoint(new URL("/lifecycle/list", baseUrl), { method: "GET" }, { fetchImpl, stdout, stderr });
  }
  if (positionals.length !== 1) {
    stderr.write(`Usage: forge project ${action} <absolute-root> [--server <url>]\n`);
    return 1;
  }
  const root = String(positionals[0]).trim();
  if (!root || !root.startsWith("/")) {
    stderr.write("Project root must be a non-empty absolute path.\n");
    return 1;
  }
  return invokeLifecycleEndpoint(
    new URL(`/lifecycle/${action}`, baseUrl),
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ root }) },
    { fetchImpl, stdout, stderr }
  );
}

// Performs a single-shot HTTP request to a Control API lifecycle endpoint and prints its JSON result or error.
async function invokeLifecycleEndpoint(endpointUrl, init, { fetchImpl, stdout, stderr }) {
  try {
    const response = await fetchImpl(endpointUrl, init);
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (error) {
      stderr.write(`Invalid JSON response (${response.status}): ${error.message}\n`);
      return 1;
    }
    if (!response.ok) {
      const code = payload?.error?.code ?? `http_${response.status}`;
      const message = payload?.error?.message ?? (text || "Project lifecycle request failed.");
      stderr.write(`${code}: ${message}\n`);
      return 1;
    }
    stdout.write(`${JSON.stringify(payload)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

export async function runCli(args, { cwd = process.cwd(), env = process.env, fetchImpl = globalThis.fetch, stdout = process.stdout, stderr = process.stderr, signalEmitter = process, watchProject = startProjectWatch, embeddingProvider } = {}) {
  if (args[0] === "project") {
    const exitCode = await runProjectCli(args, { env, fetchImpl, stdout, stderr });
    if (exitCode !== null) {
      return exitCode;
    }
  }
  if (args[0] === "index" && args[1] === "rebuild" && (args.length === 2 || (args.length === 3 && args[2] === "--force"))) {
    let processed = 0;
    const database = await openIndexDatabase(cwd, { runtimeDir: ".forge/runtime/wc" });
    const model = process.env.OLLAMA_EMBED_MODEL ?? "embeddinggemma";
    const jobs = createEmbeddingJobStore({ database });
    const worker = createEmbeddingWorker({ database, jobs, embeddingStore: createEmbeddingStore({ database }), embeddingProvider: embeddingProvider ?? createOllamaEmbeddingProvider({ baseUrl: process.env.OLLAMA_BASE_URL ?? "http://192.168.1.180:11434", model, timeoutMs: 300000 }), model });
    const workerTask = worker.start({ pollMs: 500 });
    try {
      const { indexedFiles } = await rebuildIndex({
        projectRoot: cwd,
        database,
        embeddingJobs: jobs,
        embeddingModel: model,
        onFile: ({ path, indexed, phase, skipped }) => {
          if (phase !== "index") return;
          processed += 1;
          stdout.write(`[${processed}] ${skipped ? "skipped" : indexed ? "indexed" : "failed"} ${path}\n`);
        },
        force: args[2] === "--force"
      });
      while (Object.entries(jobs.counts()).some(([status, count]) => ["pending", "processing", "retry_wait"].includes(status) && count > 0)) await new Promise((resolve) => setTimeout(resolve, 500));
      stdout.write(`Rebuilt index for ${indexedFiles} files.\n`);
      return 0;
    } finally {
      worker.stop();
      // eslint-disable-next-line no-silent-catch -- Worker shutdown is best-effort; rebuild result already computed.
      await workerTask.catch(() => {});
      await database.close();
    }
  }
  if (args[0] === "watch" && args.length <= 2) {
    const projectRoot = resolve(cwd, args[1] ?? ".");
    const watch = await watchProject({
      projectRoot,
      loggerOptions: { sink: { log: ({ message, ...fields }) => stdout.write(`${message}${Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ""}\n`) } }
    });
    stdout.write(watch.baselineRebuilt ? `Rebuilt baseline index for ${watch.baselineIndexedFiles} files.\n` : "Using existing index baseline.\n");
    stdout.write(`Watching ${watch.projectRoot}.\n`);
    await onceSignal(signalEmitter, "SIGINT");
    await watch.close();
    return 0;
  }
  stderr.write("Usage: forge index rebuild [--force] | forge watch [path]\n");
  return 1;
}

// Waits for a single process signal.
function onceSignal(emitter, signal) {
  return new Promise((resolveSignal) => emitter.once(signal, resolveSignal));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const exitCode = await runCli(process.argv.slice(2));
  if (exitCode !== 0) process.exitCode = exitCode;
}
