// Runs project searches with bounded output and cancellation so Stop also terminates the underlying ripgrep process.
import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";

// Returns explicit truncation when search output reaches its budget instead of buffering unbounded runtime logs.
export function runProjectRipgrep(cwd, args, environment, input, { signal, maxOutputBytes = 200000, stdoutLineFilter } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const env = { ...environment };
    delete env.RIPGREP_CONFIG_PATH;
    delete env.RG_CONFIG_PATH;
    const child = spawn(rgPath, args, { cwd, env, shell: false, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    let bytes = 0; let truncated = false;
    // Keeps source matches and diagnostics within one shared memory budget.
    const capture = (target, chunk) => {
      const remaining = maxOutputBytes - bytes;
      if (remaining > 0) { target.push(chunk.subarray(0, remaining)); bytes += Math.min(chunk.length, remaining); }
      if (chunk.length > remaining) { truncated = true; child.kill("SIGKILL"); }
    };
    // Terminates native work immediately when the owning agent execution stops.
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let pending = Buffer.alloc(0);
    // Filters baseline filename records before buffering so unrelated project size cannot deny narrow discovery.
    // The pending record retains the same byte ceiling, including when a malformed record has no newline.
    const captureFiltered = (chunk) => {
      const records = Buffer.concat([pending, chunk]);
      let start = 0;
      for (let end = records.indexOf(10); end !== -1; end = records.indexOf(10, start)) {
        const record = records.subarray(start, end + 1);
        if (record.length > maxOutputBytes) { truncated = true; child.kill("SIGKILL"); return; }
        if (stdoutLineFilter(record.subarray(0, -1).toString("utf8"))) capture(stdout, record);
        start = end + 1;
      }
      pending = Buffer.from(records.subarray(start));
      if (pending.length > maxOutputBytes) { truncated = true; child.kill("SIGKILL"); }
    };
    child.stdout.on("data", stdoutLineFilter ? captureFiltered : (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.once("error", (error) => { signal?.removeEventListener("abort", abort); reject(error); });
    if (input !== undefined) {
      child.stdin.on("error", (error) => { if (error.code !== "EPIPE") reject(error); });
      child.stdin.end(input);
    }
    child.once("close", (code, terminationSignal) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) { reject(signal.reason ?? new Error("Search cancelled.")); return; }
      if (stdoutLineFilter && pending.length && stdoutLineFilter(pending.toString("utf8"))) capture(stdout, pending);
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exit_code: truncated ? 0 : code, signal: truncated ? null : terminationSignal, ...(truncated ? { truncated: true, output_limit_bytes: maxOutputBytes } : {}) });
    });
  });
}
