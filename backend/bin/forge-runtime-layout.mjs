#!/usr/bin/env node
// Read-only inventory for the staged runtime regrouping. Never follows storage symlinks.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventory } from "../src/infrastructure/filesystem/runtime-layout-inventory.js";
export { inventory };
export { RUNTIME_GROUPS as GROUPS } from "../src/infrastructure/filesystem/runtime-layout.js";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error("This command only inventories the repository runtime; no --apply is implemented.");
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await inventory(fileURLToPath(new URL("../../", import.meta.url))), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
