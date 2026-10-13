// Executes one approved browser step against the current ticket source directory and emits its Node-owned receipt.
import { fileURLToPath } from "node:url";
import { runBrowserVerification } from "../src/modules/supervisor/browser-verification-runner.js";

try {
  const step = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8"));
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const receipt = await runBrowserVerification({ step, projectRoot, sourceRoot: process.cwd() });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch (error) {
  console.error(`${error.code ?? "VERIFY_BROWSER_FAILED"}: ${error.message}`);
  process.exitCode = 1;
}
