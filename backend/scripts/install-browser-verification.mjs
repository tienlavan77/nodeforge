// Provisions Chromium for root pnpm dependencies without installing runtime packages or changing system packages.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(projectRoot, "package.json"));
const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" };

// Provisions explicit project-local tooling and surfaces installation failures instead of silently skipping browser checks.
async function execute(argv) {
  const child = spawn(argv[0], argv.slice(1), { cwd: projectRoot, env, stdio: "inherit" });
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${argv[0]} exited ${code}.`))); });
}

try {
  const cli = require.resolve(join(projectRoot, "node_modules/playwright/cli.js"));
  require.resolve(join(projectRoot, "node_modules/esbuild"));
  await execute([process.execPath, cli, "install", "chromium"]);
  console.log("Chromium for root pnpm browser-verification dependencies is ready.");
} catch (error) {
  console.error(`VERIFY_BROWSER_INSTALL_FAILED: ${error.message}${error.code === "MODULE_NOT_FOUND" ? " Run pnpm install at the project root first." : ""}`);
  process.exitCode = 1;
}
