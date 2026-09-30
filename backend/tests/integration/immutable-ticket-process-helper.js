// Queries a disposable Control API child so restart tests inspect persisted ticket receipts.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const childPath = fileURLToPath(new URL("../fixtures/immutable-ticket-witness-child.mjs", import.meta.url));

// Launches and stops one test-owned process after fetching its durable evidence response.
export async function inspectTicketProcess(projectRoot, projectId, taskId) {
  const child = spawn(process.execPath, [childPath, projectRoot, projectId, taskId], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  try {
    const port = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Control API witness startup timed out.")), 10_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (!output.includes("\n")) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(output.split("\n")[0]).port); } catch (error) { reject(error); }
      });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Control API witness exited ${code}: ${stderr}`)); });
    });
    const response = await fetch(`http://127.0.0.1:${port}/forge/v1/tickets/${taskId}/evidence`, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json();
    if (!response.ok) throw new Error(`Control API witness returned ${response.status}: ${JSON.stringify(body)}`);
    return body;
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
  }
}
