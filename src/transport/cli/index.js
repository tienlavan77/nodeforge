#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { rebuildIndex } from "../../modules/index/index-rebuild.js";
import { startProjectWatch } from "../../modules/watcher/watch-project.js";

export async function runCli(args, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, signalEmitter = process, watchProject = startProjectWatch } = {}) {
  if (args[0] === "index" && args[1] === "rebuild" && args.length === 2) {
    const { indexedFiles } = await rebuildIndex({ projectRoot: cwd });
    stdout.write(`Rebuilt index for ${indexedFiles} files.\n`);
    return 0;
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
  stderr.write("Usage: forge index rebuild | forge watch [path]\n");
  return 1;
}

function onceSignal(emitter, signal) {
  return new Promise((resolveSignal) => emitter.once(signal, resolveSignal));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const exitCode = await runCli(process.argv.slice(2));
  if (exitCode !== 0) process.exitCode = exitCode;
}
