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
export async function runCli(args, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, signalEmitter = process, watchProject = startProjectWatch } = {}) {
  if (args[0] === "index" && args[1] === "rebuild" && (args.length === 2 || (args.length === 3 && args[2] === "--force"))) {
    let processed = 0;
    const database = await openIndexDatabase(cwd, { runtimeDir: ".forge/runtime/wc" });
    const model = process.env.OLLAMA_EMBED_MODEL ?? "embeddinggemma";
    const jobs = createEmbeddingJobStore({ database });
    const worker = createEmbeddingWorker({ database, jobs, embeddingStore: createEmbeddingStore({ database }), embeddingProvider: createOllamaEmbeddingProvider({ baseUrl: process.env.OLLAMA_BASE_URL ?? "http://192.168.1.180:11434", model, timeoutMs: 300000 }), model });
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
