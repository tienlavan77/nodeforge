// Rejects unavailable browser acceptance before reserving a Coder or modifying ticket sources.
import { existsSync } from "node:fs";
import { assertCodingBrowserStep } from "./browser-coding-contract.js";
import { loadBrowserTools } from "./browser-verification-runner.js";

// Validates planned scenarios without requiring Coder's future implementation to exist yet.
export async function preflightBrowserVerification(plan, { projectRoot, loadTools = loadBrowserTools, exists = existsSync } = {}) {
  const steps = plan?.filter((step) => step?.kind === "browser") ?? [];
  if (!steps.length) return;
  for (const step of steps) assertCodingBrowserStep(step);
  const tools = loadTools(projectRoot);
  const executable = tools.chromium.executablePath();
  if (!exists(executable)) throw Object.assign(new Error("Browser verification requires installed Chromium. Run pnpm browser:install at the project root before RUN."), { code: "VERIFY_BROWSER_TOOLS_MISSING" });
  let browser;
  try { browser = await tools.chromium.launch({ headless: true }); }
  catch (error) { throw Object.assign(new Error(`Browser cannot launch before Coder dispatch: ${error.message}`), { code: "VERIFY_BROWSER_TOOLS_MISSING", cause: error }); }
  finally { await browser?.close(); }
}
