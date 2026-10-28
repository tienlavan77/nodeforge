/** Reproduces already-issued supplemental plans for baseline compatibility
 * tests. Production selection no longer discovers tests through shared imports;
 * old artifacts must still support attribution and recovery without losing ACs. */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTicketVerificationPlan } from "../../src/modules/supervisor/ticket-verification-plan.js";

/** Adds the explicitly prepared legacy regression fixtures to the current AC
 * checks, preserving the command order of plans created before scope narrowing. */
export async function buildLegacyRegressionPlan(paths, root, options) {
  const commands = await buildTicketVerificationPlan(paths, root, options);
  for (const name of (await readdir(join(root, "backend/tests/unit"))).sort()) {
    if (!["existing.test.js", "z-existing.test.js", "zzz-new.test.js"].includes(name)) continue;
    const path = `backend/tests/unit/${name}`;
    if (commands.some(command => command.argv.includes(path))) continue;
    commands.push({ kind: "backend_tests", scope: "regression", test_paths: [path], related_paths: ["backend/src/shared.js"],
      reason: "Recorded legacy regression fixture for shared value behavior",
      argv: [process.execPath, "--test", `--test-reporter=${fileURLToPath(new URL("../../src/modules/supervisor/ticket-verification-reporter.js", import.meta.url))}`, path] });
  }
  return commands;
}
