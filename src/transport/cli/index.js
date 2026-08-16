#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { rebuildIndex } from "../../modules/index/index-rebuild.js";

export async function runCli(args, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  if (args[0] === "index" && args[1] === "rebuild" && args.length === 2) {
    const { indexedFiles } = await rebuildIndex({ projectRoot: cwd });
    stdout.write(`Rebuilt index for ${indexedFiles} files.\n`);
    return 0;
  }
  stderr.write("Usage: forge index rebuild\n");
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const exitCode = await runCli(process.argv.slice(2));
  if (exitCode !== 0) process.exitCode = exitCode;
}
