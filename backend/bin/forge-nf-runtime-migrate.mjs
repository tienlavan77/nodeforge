#!/usr/bin/env node
// Provides read-only nf preflight and explicit offline apply/rollback for the current checkout.
// The default command never fences live writers; actual cutover additionally requires confirmation
// that SDK child processes have stopped, since their opaque locks cannot establish ownership here.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateNfRuntime } from "../src/infrastructure/filesystem/nf-runtime-migration.js";

/** Validates operator flags and prevents an unexpected custom data directory from being migrated. */
async function main(argv) {
  if (argv.some(arg => !["--apply", "--rollback", "--offline", "--sdk-stopped"].includes(arg))) throw new Error("Usage: forge-nf-runtime-migrate.mjs [--apply | --rollback] [--offline --sdk-stopped]");
  const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  if (process.env.NODE_CONTROL_DATA_DIR && resolve(root, process.env.NODE_CONTROL_DATA_DIR) !== resolve(root, ".forge/runtime/nf")) throw new Error("Custom NODE_CONTROL_DATA_DIR requires its own migration mapping.");
  console.log(JSON.stringify(await migrateNfRuntime(root, { apply: argv.includes("--apply"), rollback: argv.includes("--rollback"), offline: argv.includes("--offline"), sdkStopped: argv.includes("--sdk-stopped") }), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
