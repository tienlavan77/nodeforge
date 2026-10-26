#!/usr/bin/env node
// Offline command for grouping runtime stores and recovering interrupted migrations. The default
// invocation is inventory-only; actual project mutation requires --apply --offline or --rollback
// --offline, plus successful live-owner, collision, and content-verification gates.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { migrateRuntime } from "../src/infrastructure/filesystem/runtime-migration.js";

/** Runs only against this checkout; tests use the imported migration API with project-local fixtures. */
async function main(argv) {
  if (argv.some((arg) => !["--apply", "--rollback", "--offline"].includes(arg))) throw new Error("Usage: forge-runtime-migrate.mjs [--apply | --rollback] [--offline]");
  const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  console.log(JSON.stringify(await migrateRuntime(root, { apply: argv.includes("--apply"), rollback: argv.includes("--rollback"), offline: argv.includes("--offline") }), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
}
