#!/usr/bin/env node
/**
 * Business purpose: gives NodeForge operators one low-risk view of Control API
 * liveness and the storage signals that accompany a SIGBUS crash, so they can
 * distinguish a dead API from an SSE-only disconnect and correlate sub-agent
 * concurrency with SQLite WAL or mmap changes.
 * Technical description: polls a configurable health URL and process ID,
 * records `/proc` file mappings and descriptors for the selected SQLite files,
 * samples filesystem capacity, and reads recent kernel messages when permitted.
 * This monitor is observational only: it never opens SQLite for writing, never
 * removes WAL/SHM files, and never changes the process being diagnosed.
 */

import { existsSync, readlinkSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_HEALTH_URL = "http://127.0.0.1:3000/forge/v1/health";
const DEFAULT_DATABASE = ".forge/runtime/wc/index.db";
const KERNEL_TERMS = /sigbus|bus[_ ]adrerr|bus error|mmap|sqlite|i\/o error|wal|shm/i;

/**
 * Business purpose: converts CLI arguments into a bounded monitoring session
 * that operators can safely run against the current API process.
 * Technical description: accepts PID, health URL, database path, interval,
 * and one-shot mode while rejecting malformed numeric values before polling.
 */
function parseOptions(argv) {
  const options = { intervalMs: DEFAULT_INTERVAL_MS, healthUrl: DEFAULT_HEALTH_URL, database: DEFAULT_DATABASE, once: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--once") options.once = true;
    else if (argument === "--json") options.json = true;
    else if (["--pid", "--interval-ms", "--health-url", "--db"].includes(argument)) {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value.`);
      if (argument === "--pid") options.pid = parsePositiveInteger(value, "PID");
      if (argument === "--interval-ms") options.intervalMs = Math.max(250, parsePositiveInteger(value, "interval-ms"));
      if (argument === "--health-url") options.healthUrl = value;
      if (argument === "--db") options.database = value;
    } else if (argument === "--help") return { help: true };
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

/**
 * Business purpose: prevents an invalid process or polling value from making
 * the monitor report misleading diagnostics.
 * Technical description: parses a decimal integer and enforces a positive
 * range suitable for Linux process IDs and timer intervals.
 */
function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

/**
 * Business purpose: captures whether the API is reachable without treating a
 * non-2xx response as a transport failure.
 * Technical description: performs a short-timeout fetch and returns status,
 * bounded response text, and elapsed time for each sample.
 */
async function sampleHealth(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return { status: response.status, ok: response.ok, elapsedMs: Date.now() - started, body: (await response.text()).slice(0, 240) };
  } catch (error) {
    return { status: null, ok: false, elapsedMs: Date.now() - started, error: error.message };
  }
}

/**
 * Business purpose: records the SQLite sidecars whose growth or disappearance
 * can explain a SIGBUS while the API is using WAL mode.
 * Technical description: reads metadata for the database, `-wal`, and `-shm`
 * paths without opening SQLite or changing journal state.
 */
function sampleDatabase(database) {
  return Object.fromEntries([database, `${database}-wal`, `${database}-shm`].map((path) => {
    try {
      const stat = statSync(path);
      return [path, { exists: true, bytes: stat.size, mtime: stat.mtime.toISOString() }];
    } catch (error) {
      return [path, { exists: false, error: error.code ?? error.message }];
    }
  }));
}

/**
 * Business purpose: shows whether one API process currently holds SQLite mmap
 * and descriptor handles, which helps separate same-process async pressure from
 * multiple-process database ownership.
 * Technical description: inspects `/proc/<pid>/fd` and `/proc/<pid>/maps`,
 * returning only entries that reference the selected database filename.
 */
function sampleProcess(pid, database) {
  if (!pid) return { pid: null, alive: null, descriptors: [], mappings: [], note: "No --pid supplied." };
  const procRoot = `/proc/${pid}`;
  if (!existsSync(procRoot)) return { pid, alive: false, descriptors: [], mappings: [] };
  const databaseName = database.split("/").at(-1);
  const descriptors = readDirectory(`${procRoot}/fd`).map((entry) => {
    try { return { fd: entry, target: readlinkSync(`${procRoot}/fd/${entry}`) }; }
    catch (error) { return { fd: entry, target: `unavailable: ${error.code ?? error.message}` }; }
  }).filter(({ target }) => target.includes(databaseName));
  const mappings = readText(`${procRoot}/maps`).split("\n").filter((line) => line.includes(databaseName));
  return { pid, alive: true, descriptors, mappings };
}

/**
 * Business purpose: obtains a small kernel signal sample without requiring the
 * operator to run a separate terminal during reproduction.
 * Technical description: invokes `dmesg` read-only, keeps only diagnostic terms,
 * and reports permission failures explicitly.
 */
async function sampleKernel() {
  try {
    const { stdout } = await execFileAsync("dmesg", ["-T", "--level=err,warn,crit,alert,emerg"], { timeout: 1500, maxBuffer: 256 * 1024 });
    return stdout.split("\n").filter((line) => KERNEL_TERMS.test(line)).slice(-20);
  } catch (error) {
    return [`unavailable: ${error.code ?? error.message}`];
  }
}

/**
 * Business purpose: keeps filesystem capacity visible so operators do not
 * attribute a SIGBUS to SQLite when the underlying volume is actually full.
 * Technical description: reads `df` for the database filesystem and returns
 * the final filesystem row, with an explicit failure result when unavailable.
 */
async function sampleFilesystem(database) {
  try {
    const { stdout } = await execFileAsync("df", ["-P", "-h", database], { timeout: 1500 });
    const lines = stdout.trim().split("\n");
    return lines.at(-1) ?? "unavailable";
  } catch (error) {
    return `unavailable: ${error.code ?? error.message}`;
  }
}

/**
 * Business purpose: emits one timestamped, machine-readable observation that
 * can be attached to a crash report and compared across sync/async trials.
 * Technical description: combines health, process, database, filesystem, and
 * kernel samples while preserving bounded fields for terminal readability.
 */
async function sample(options) {
  const [health, kernel, filesystem] = await Promise.all([sampleHealth(options.healthUrl), sampleKernel(), sampleFilesystem(options.database)]);
  return { timestamp: new Date().toISOString(), health, process: sampleProcess(options.pid, options.database), database: sampleDatabase(options.database), filesystem, kernel };
}

/**
 * Business purpose: presents each health sample as a compact dashboard line so
 * operators can notice an API crash without decoding JSON during reproduction.
 * Technical description: derives API, process, SQLite sidecar, filesystem, and
 * kernel status from one observation while retaining the full JSON mode.
 */
function formatObservation(observation) {
  const health = observation.health.status === 200 ? "API UP" : observation.health.status ? `API HTTP ${observation.health.status}` : "API UNREACHABLE";
  const process = observation.process.alive === true ? `PID ${observation.process.pid} alive` : observation.process.alive === false ? `PID ${observation.process.pid} DEAD` : "PID unknown";
  const database = Object.values(observation.database).map((item) => item.exists ? `${item.bytes}B` : "missing").join(" / ");
  const kernel = observation.kernel.some((line) => !line.startsWith("unavailable:")) ? "kernel signal FOUND" : "kernel quiet/unavailable";
  return `[${observation.timestamp}] ${health} | ${process} | DB/WAL/SHM ${database} | ${kernel}`;
}

/**
 * Business purpose: runs the operator-facing monitor until one-shot completion
 * or an interrupt, making every sample easy to archive as JSON Lines.
 * Technical description: prints a startup configuration and then serializes
 * each observation; timer cleanup prevents a dangling process on SIGINT.
 */
async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: node backend/scripts/api-crash-monitor.mjs [--pid PID] [--health-url URL] [--db PATH] [--interval-ms N] [--once] [--json]\n");
    return;
  }
  process.stdout.write(`${JSON.stringify({ monitor: "api-crash", options })}\n`);
  let timer;
  let stopped = false;
  const stop = () => { stopped = true; if (timer) clearTimeout(timer); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  while (!stopped) {
    const observation = await sample(options);
    process.stdout.write(`${options.json ? JSON.stringify(observation) : formatObservation(observation)}\n`);
    if (options.once) break;
    await new Promise((resolve) => { timer = setTimeout(resolve, options.intervalMs); });
  }
}

/** Reads a procfs text file and returns an empty value when the process exits during sampling. */
function readText(path) { try { return readFileSync(path, "utf8"); } catch (error) { return `unavailable: ${error.code ?? error.message}`; } }

/** Lists a procfs directory and returns an empty list when the process exits during sampling. */
function readDirectory(path) { try { return readdirSync(path); } catch (error) { return []; } }

main().catch((error) => { process.stderr.write(`api-crash-monitor failed: ${error.stack ?? error.message}\n`); process.exitCode = 1; });
