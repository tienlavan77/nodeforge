#!/usr/bin/env node
// Offline janitor for `.forge/runtime`. It never runs while the Control API or watcher owns live
// state: Gate 0 reads each PID-bearing lock and refuses to mutate if any owner process is still
// alive. Deletions default to a dry run that prints a manifest; nothing is removed until --apply.
// Safety model: a fixed KEEP allow-list of code-referenced state directories, a NEEDS-CONFIRM list
// of orphaned directories reported but never auto-deleted, and conservative classification so an
// unrecognized entry is preserved rather than removed.
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const runtimeRoot = join(projectRoot, ".forge/runtime");

// State directories referenced by src/ or required by the runtime; never deleted by this tool.
const KEEP_DIRECTORIES = new Set([
  "queues", "protocol-storage", "processed-requests", "agent-checkpoints", "reviewer-checkpoints",
  "reports", "review-records", "review-dependency-reconciliation", "ticket-changes", "ticket-workspaces",
  "ticket-execution-contexts", "ticket-verification", "ticket-integrations", "ticket-root-commits",
  "ticket-pipeline-shadow", "automatic-review-locks", "evidence-mapping-recovery", "blocker-contract-decisions",
  "agent-checkpoint-decisions", "recovery-backups", "repair-backups", "owner-executions", "architecture-executions",
  "supervisors", "ticket-baselines", "ticket-finding-repairs", "ticket-pipeline-disposition", "ticket-pipeline-rollout",
  "ticket-review-findings", "ticket-review-repairs", "ticket-root-workspaces", "ticket-run-dispositions",
  "node-runtime", "npm-cache", "pnpm-cli", "browser-tools", "wc", "nf",
  // Live state discovered during cleanup: prompt/exchange storage written by agent-exchange-storage.js
  // and blocker-prompt-context.js, plus the sandboxed .claude workspace inside the runtime tree.
  "agent-messages", "blocker-context", ".claude"
]);
// Top-level files that describe live state and must survive cleanup.
const KEEP_FILES = new Set(["project.json", "index.db", "index.db-shm", "index.db-wal"]);
// Directories no longer referenced by src/; reported for owner decision, never auto-deleted here.
const ORPHAN_DIRECTORIES = new Set([
  "review-findings-recovery", "review-format-recovery", "review-limit-recovery", "review-policy-amendment",
  "review-reopen", "review-repair-recovery", "review-reruns", "reviewer-access", "source-reconciliations",
  "ticket-pipeline-release", "ticket-reconciliations", "ticket-resume-repairs", "ticket-review-retries",
  "ticket-scope-audits", "verification-scope-recovery", "owner-recovery"
]);
const JUNK_FILE_EXTENSIONS = /\.(?:log|png|txt|mjs|py|json)$/i;
// mkdtemp appends exactly six alphanumeric characters, so a trailing random token marks throwaway dirs.
const RANDOM_SUFFIX = /-[A-Za-z0-9]{6}$/;
const TEST_PREFIX = /^(?:architecture-choices-test-|read-code-|read-transcript-tool-|search-code-|select-graph-|coding-lifecycle-profile-|conversation-input-history-|conversation-markdown-|conversation-reconnect-|coding-plan-refresh-|browser-coding-lifecycle-|coding-layout-|agents-browser-|project-stream-reconnect-|browser-scenario-|browser-service-|ticket-failed-release-|ticket-terminal-policy-|recovery-test-tmp|nf-debug-)/;

// Returns true when a process is currently running under the given PID.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

// Collects the top-level runtime entries into mutually exclusive cleanup classes.
export function classify(entries) {
  const keep = [], garbage = [], orphans = [], unknown = [];
  for (const entry of entries) {
    if (KEEP_DIRECTORIES.has(entry.name) || KEEP_FILES.has(entry.name)) { keep.push(entry.name); continue; }
    if (ORPHAN_DIRECTORIES.has(entry.name)) { orphans.push(entry.name); continue; }
    if (entry.kind === "directory" && (TEST_PREFIX.test(entry.name) || RANDOM_SUFFIX.test(entry.name))) { garbage.push(entry.name); continue; }
    if (entry.kind === "file" && JUNK_FILE_EXTENSIONS.test(entry.name)) {
      // A recognized *.json may still be state; only the throwaway check/reset files qualify as junk.
      if (!/\.json$/i.test(entry.name) || /(?:check|reset|probe|proxy|before)/i.test(entry.name)) { garbage.push(entry.name); continue; }
    }
    unknown.push(entry.name);
  }
  return { keep, garbage, orphans, unknown };
}

// Locates PID-bearing lock files across the runtime's known lock directories.
function findLockFiles() {
  const locks = [];
  const scan = (dir) => {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const full = join(dir, name);
      if (name === ".forge" || KEEP_DIRECTORIES.has(name) || name === "queues") continue;
      let info; try { info = statSync(full); } catch { continue; }
      if (info.isDirectory()) scan(full);
    }
  };
  // Only these roots hold queue/owner locks; we do not descend into large state trees.
  const roots = [join(runtimeRoot, "nf"), join(runtimeRoot, "queues"), join(runtimeRoot, "automatic-review-locks"), join(runtimeRoot, "blocker-contract-decisions")];
  for (const dir of roots) {
    let names; try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/\.lock$/i.test(name)) continue;
      locks.push(join(dir, name));
    }
  }
  return locks;
}

// Gate 0: refuses mutation when a live lock owner exists; returns the stale owners otherwise.
function gate0({ allowStale }) {
  const stale = [];
  for (const path of findLockFiles()) {
    let pid = null;
    try { pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10); } catch { /* unreadable lock stays conservative below */ }
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
      console.error(`ABORT: live lock owner pid=${pid} at ${path}. Stop the Control API/watcher first (see README guide).`);
      process.exit(1);
    }
    stale.push({ path, pid });
  }
  if (stale.length && !allowStale) console.error(`NOTE: ${stale.length} stale lock(s) found; pass --include-stale-locks to remove them.`);
  return stale;
}

function listTopLevel() {
  return readdirSync(runtimeRoot, { withFileTypes: true }).map((d) => ({ name: d.name, kind: d.isDirectory() ? "directory" : "file" }));
}

function main(argv) {
  const apply = argv.includes("--apply");
  const includeStaleLocks = argv.includes("--include-stale-locks");
  const staleLocks = gate0({ allowStale: includeStaleLocks });
  const { keep, garbage, orphans, unknown } = classify(listTopLevel());
  const report = { dryRun: !apply, keep, garbage, orphans, unknown, staleLocks: includeStaleLocks ? staleLocks.map((l) => l.path) : [] };
  console.log(JSON.stringify(report, null, 2));
  console.error(`dry-run=${!apply} garbage=${garbage.length} orphans(needs-confirm)=${orphans.length} unknown(preserved)=${unknown.length} staleLocks=${report.staleLocks.length}`);
  if (!apply) { console.error("Nothing removed. Re-run with --apply to delete only the garbage list."); return; }
  let removed = 0;
  for (const name of garbage) { rmSync(join(runtimeRoot, name), { recursive: true, force: true }); removed += 1; }
  for (const path of report.staleLocks) { rmSync(path, { force: true }); removed += 1; }
  console.error(`Removed ${removed} item(s). Orphaned directories were preserved for owner review.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
