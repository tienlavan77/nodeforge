// Builds isolated root Git commits so ticket changes never stage unrelated project files.
import { execFile as callback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { ConfigurationError } from "../../shared/errors.js";

const execFile = promisify(callback);
const sha = (value) => value === null ? null : `sha256:${createHash("sha256").update(value).digest("hex")}`;
const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });

// Provides bounded Git commands with an optional transaction-private index.
export function createTicketRootGit({ projectRoot } = {}) {
  if (!projectRoot || !isAbsolute(projectRoot)) throw fail("CONFIGURATION_ERROR", "Root ticket Git requires an absolute project root.");
  return Object.freeze({ run, optional, fileAt, modeAt, indexIdentity, checkedBranch, assertAncestor, buildTree, verifyTree, findTransactionCommit });

  // Runs one Git command without a shell and preserves stderr on failure.
  async function run(args, { indexFile, maxBuffer = 16 * 1024 * 1024 } = {}) {
    try {
      const { stdout } = await execFile("git", ["-C", projectRoot, ...args], { encoding: "utf8", timeout: 30_000, maxBuffer, env: indexFile ? { ...process.env, GIT_INDEX_FILE: indexFile } : process.env });
      return stdout;
    } catch (error) { throw fail("TICKET_ROOT_GIT_FAILED", `Git ${args[0]} failed: ${String(error.stderr ?? error.message).slice(0, 320)}`); }
  }

  // Distinguishes a missing Git object/path from other command failures.
  async function optional(args, options) {
    try { return await run(args, options); }
    catch (error) { if (args[0] === "rev-parse" && args[1] === "--verify") return null; throw error; }
  }

  // Reads a text blob from one immutable tree, returning null for absent paths.
  async function fileAt(tree, path) {
    const exists = await optional(["rev-parse", "--verify", `${tree}:${path}`]);
    return exists ? run(["show", `${tree}:${path}`]) : null;
  }

  // Reads a file mode from a committed tree without consulting mutable root files.
  async function modeAt(tree, path) {
    const result = await run(["ls-tree", tree, "--", `:(literal)${path}`]);
    const line = result.split("\n").find((item) => item.endsWith(`\t${path}`));
    return line?.split(" ", 1)[0] ?? null;
  }

  // Fingerprints the shared index before a commit can synchronize it.
  async function indexIdentity() {
    const raw = (await run(["rev-parse", "--git-path", "index"])).trim();
    const path = isAbsolute(raw) ? raw : join(projectRoot, raw);
    let bytes;
    try { bytes = await readFile(path); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    return sha(bytes);
  }

  // Requires a named branch for compare-and-swap advancement.
  async function checkedBranch() {
    const ref = (await run(["symbolic-ref", "HEAD"])).trim();
    if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref)) throw fail("TICKET_ROOT_BRANCH_INVALID", "Root ticket commit requires a checked-out branch.");
    return ref;
  }

  // Checks that reviewed commit evidence is still reachable from root HEAD.
  async function assertAncestor(commit) {
    try { await run(["merge-base", "--is-ancestor", commit, "HEAD"]); }
    catch { throw fail("TICKET_COMMIT_UNREACHABLE", "Recorded ticket commit is absent from root history."); }
  }

  // Finds a crash-orphaned commit only when its trailer, parent, and tree all match.
  async function findTransactionCommit({ transactionId, parent, tree }) {
    const candidates = (await run(["fsck", "--unreachable", "--no-reflogs", "--no-progress"])).split("\n").map((line) => /(?:unreachable|dangling) commit ([a-f0-9]{40,64})/.exec(line)?.[1]).filter(Boolean);
    if (candidates.length > 500) throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Too many unreachable Git commits to identify a ticket transaction safely.");
    const matching = [];
    for (const commit of candidates) {
      if ((await run(["rev-parse", `${commit}^{tree}`])).trim() !== tree) continue;
      if ((await run(["rev-list", "--parents", "-n", "1", commit])).trim() !== `${commit} ${parent}`) continue;
      const message = await run(["log", "-1", "--format=%B", commit]);
      if (message.split("\n").some((line) => line === `X-Ticket-Tx: ${transactionId}`)) matching.push(commit);
    }
    if (matching.length > 1) throw fail("TICKET_COMMIT_RECOVERY_CONFLICT", "Several Git commits claim the same ticket transaction.");
    return matching[0] ?? null;
  }

  // Stages manifest paths in a private index and returns the exact candidate tree.
  async function buildTree(parent, paths, indexFile) {
    await run(["read-tree", parent], { indexFile });
    await run(["add", "-A", "--", ...paths.map((path) => `:(literal)${path}`)], { indexFile });
    const changed = (await run(["diff", "--cached", "--name-only", parent, "--"], { indexFile })).split("\n").filter(Boolean).sort();
    if (JSON.stringify(changed) !== JSON.stringify([...paths].sort())) throw fail("TICKET_COMMIT_SCOPE_CONFLICT", "Candidate tree paths differ from the frozen ticket manifest.");
    return (await run(["write-tree"], { indexFile })).trim();
  }

  // Checks every candidate blob and mode against the ledger before creating a commit.
  async function verifyTree(parent, tree, entries, expectedPaths) {
    for (const path of expectedPaths) {
      const entry = entries[path];
      const content = await fileAt(tree, path);
      if (sha(content) !== entry.latest_sha) throw fail("TICKET_COMMIT_SCOPE_CONFLICT", `Candidate blob differs from the ticket ledger: ${path}.`);
      const beforeMode = await modeAt(parent, path);
      const afterMode = await modeAt(tree, path);
      if (afterMode && afterMode !== (beforeMode ?? "100644")) throw fail("TICKET_COMMIT_SCOPE_CONFLICT", `Candidate file mode is not journaled: ${path}.`);
    }
  }
}

// Creates a temporary path for a transaction-private Git index.
export function ticketIndexPath(directory) { return join(directory ?? tmpdir(), "index"); }
