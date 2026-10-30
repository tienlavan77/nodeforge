// Diagnoses production bundler stalls before the Forge transport deadline so
// owners receive durable compiler output rather than an unexplained timeout.
// The normal production build remains the acceptance gate; this bounded probe
// runs Turbopack explicitly, preserves its output under project runtime reports,
// and terminates only the process group created by this invocation.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
// Runs the real production command with durable stdout and an independent time
// bound so transport failures cannot erase compiler evidence. The optional
// Turbopack probe diagnoses the alternate bundler; callers must still require
// exit zero from the configured production build before claiming its gate passed.
export async function verifyUiProductionBuild(turbopack = true, buildArgs = []) {
  const directory = resolve(root, ".forge/runtime/reports");
  await mkdir(directory, { recursive: true });
  const argv = turbopack ? ["--dir", "ui/nextjs", "exec", "next", "build", "--turbopack", "--debug"] : ["--dir", "ui/nextjs", "build", ...buildArgs];
  const started = Date.now();
  const child = spawn("pnpm", argv, { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-2_000_000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2_000_000); });
  
  // Stops only this probe's compiler and descendants, including workers that
  // would otherwise survive the parent command and block subsequent builds.
  function stopProbe(signal) {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") console.error(error); }
  }
  const timeout = setTimeout(() => { timedOut = true; stopProbe("SIGTERM"); }, 80_000);
  const hardTimeout = setTimeout(() => stopProbe("SIGKILL"), 82_000);
  let exitCode, signal;
  try {
    [exitCode, signal] = await new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("close", (code, reason) => accept([code, reason]));
    });
  } finally {
    clearTimeout(timeout); clearTimeout(hardTimeout);
  }
  const result = { purpose: "Diagnostic output only; not a substitute for a successful production build receipt.",
    command: ["pnpm", ...argv], duration_ms: Date.now() - started, timed_out: timedOut,
    exit_code: exitCode, signal, stdout, stderr };
  await writeFile(resolve(directory, turbopack ? "repo-restructuring-turbopack-diagnostic.json" : "repo-restructuring-production-build-output.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
  process.exitCode = timedOut ? 1 : exitCode ?? 1;
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verifyUiProductionBuild();
