#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { rebuildIndex } from "../../modules/index/index-rebuild.js";
import { startProjectWatch } from "../../modules/watcher/watch-project.js";

export async function runCli(args, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, signalEmitter = process, watchProject = startProjectWatch, runtimeService } = {}) {
  if (["run", "pause", "resume", "session"].includes(args[0])) {
    if (!runtimeService) {
      stderr.write("Runtime Service is required for Agent commands.\n");
      return 1;
    }
    return runAgentCommand(args, runtimeService, stdout, stderr);
  }
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
  stderr.write("Usage: forge run <projectId> <taskId> | forge pause <sessionId> | forge resume <sessionId> | forge session <sessionId> | forge index rebuild | forge watch [path]\n");
  return 1;
}

function runAgentCommand(args, runtimeService, stdout, stderr) {
  try {
    let result;
    if (args[0] === "run" && args.length === 3) result = runtimeService.startTask({ projectId: args[1], taskId: args[2] });
    else if (args[0] === "pause" && args.length === 2) result = runtimeService.pauseSession(args[1]);
    else if (args[0] === "resume" && args.length === 2) result = runtimeService.resumeSession(args[1]);
    else if (args[0] === "session" && args.length === 2) result = runtimeService.getSession(args[1]);
    else {
      stderr.write("Usage: forge run <projectId> <taskId> | forge pause <sessionId> | forge resume <sessionId> | forge session <sessionId>\n");
      return 1;
    }
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

function onceSignal(emitter, signal) {
  return new Promise((resolveSignal) => emitter.once(signal, resolveSignal));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const exitCode = await runCli(process.argv.slice(2));
  if (exitCode !== 0) process.exitCode = exitCode;
}
