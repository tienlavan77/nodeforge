// Runs backend tests from the checkout root so repository-local scratch paths
// never resolve beneath backend/.forge. Explicit test selections remain narrow,
// and temporary fixtures stay inside the project rather than the system temp dir.
import { spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPOSITORY_ROOT } from "../src/shared/repository-root.js";

const scratch = join(REPOSITORY_ROOT, ".forge/scratch/backend-test-tmp");
mkdirSync(scratch, { recursive: true });
const args = process.argv.slice(2).map(arg => arg.startsWith("tests/") ? `backend/${arg}` : arg);
const hasSelection = args.some(arg => !arg.startsWith("-") && (arg.includes("*") || existsSync(resolve(REPOSITORY_ROOT, arg))));
const selection = hasSelection ? args : [...args, ...globSync("backend/tests/**/*.test.{js,mjs}", { cwd: REPOSITORY_ROOT }).sort()];
const result = spawnSync(process.execPath, ["--test", ...selection], {
  cwd: REPOSITORY_ROOT, stdio: "inherit", env: { ...process.env, TMPDIR: scratch }
});
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
