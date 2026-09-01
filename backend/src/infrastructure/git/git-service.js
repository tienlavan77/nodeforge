import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { ConfigurationError } from "../../shared/errors.js";

const execFile = promisify(execFileCallback);
const SAFE_BRANCH = /^(?!\.)(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$/;
const PROTECTED_BRANCHES = new Set(["main", "master", "develop"]);

export function createGitService({ projectRoot, runGit = defaultRunGit, timeoutMs = 30_000, onEvent = () => {} } = {}) {
  if (typeof projectRoot !== "string" || !projectRoot) throw new ConfigurationError("Git Service requires a project root.");
  if (typeof runGit !== "function") throw new ConfigurationError("Git Service requires a git executor.");
  if (typeof onEvent !== "function") throw new ConfigurationError("Git Service onEvent must be a function.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new ConfigurationError("Git Service timeout must be positive.");
  return Object.freeze({ status, currentBranch, branchExists, createBranch, commit, merge, discardBranch });

  async function status({ paths = [] } = {}) {
    const safePaths = validatePaths(paths);
    const result = await execute(["status", "--porcelain", ...(safePaths.length ? ["--", ...safePaths] : [])], "GIT_STATUS_FAILED");
    emit("git.status", { paths: safePaths, output: result.stdout });
    return result.stdout;
  }

  async function currentBranch() {
    const result = await execute(["branch", "--show-current"], "GIT_BRANCH_FAILED");
    return result.stdout.trim();
  }

  async function branchExists(name) {
    validateBranch(name);
    const result = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { cwd: projectRoot, timeout: timeoutMs });
    return result.exitCode === 0;
  }

  async function createBranch(name) {
    validateBranch(name);
    if (await branchExists(name)) throw gitError("GIT_BRANCH_EXISTS", `Git branch already exists: ${name}.`);
    const base = (await execute(["rev-parse", "HEAD"], "GIT_BRANCH_FAILED")).stdout.trim();
    await execute(["switch", "-c", name], "GIT_BRANCH_CREATE_FAILED");
    emit("git.branch", { action: "create", name, base_commit: base });
    return { name, base_commit: base };
  }

  async function commit(message, { paths = [] } = {}) {
    if (typeof message !== "string" || !message.trim()) throw new ConfigurationError("Git commit message is required.");
    const safePaths = validatePaths(paths);
    if (!safePaths.length) throw new ConfigurationError("Git commit requires explicit paths.");
    await execute(["add", "--", ...safePaths], "GIT_ADD_FAILED");
    emit("git.add", { paths: safePaths });
    const staged = await execute(["diff", "--cached", "--name-only", "--", ...safePaths], "GIT_STATUS_FAILED");
    const stagedPaths = staged.stdout.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
    if (stagedPaths.some((path) => !safePaths.includes(path))) throw gitError("GIT_UNEXPECTED_STAGED_PATH", "Git index contains changes outside the requested commit paths.");
    if (!stagedPaths.length) throw gitError("GIT_EMPTY_COMMIT", "Git commit has no changes.");
    const result = await execute(["commit", "-m", message], "GIT_COMMIT_FAILED");
    const sha = (await execute(["rev-parse", "HEAD"], "GIT_COMMIT_FAILED")).stdout.trim();
    emit("git.commit", { sha, paths: safePaths, message });
    return { sha, output: result.stdout };
  }

  async function merge(branch, { target } = {}) {
    validateBranch(branch);
    if (target !== undefined) validateBranch(target);
    if (!(await branchExists(branch))) throw gitError("GIT_BRANCH_NOT_FOUND", `Git branch does not exist: ${branch}.`);
    const destination = target ?? await currentBranch();
    if (destination === branch) throw gitError("GIT_MERGE_SELF", `Cannot merge branch into itself: ${branch}.`);
    if (target !== undefined && destination !== await currentBranch()) await execute(["switch", destination], "GIT_CHECKOUT_FAILED");
    const result = await execute(["merge", "--no-edit", branch], "GIT_MERGE_CONFLICT");
    emit("git.merge", { branch, target: destination });
    return { branch, target: destination, output: result.stdout };
  }

  async function discardBranch(name) {
    validateBranch(name);
    if (PROTECTED_BRANCHES.has(name)) throw gitError("GIT_PROTECTED_BRANCH", `Cannot discard protected branch: ${name}.`);
    if (name === await currentBranch()) throw gitError("GIT_CURRENT_BRANCH", `Cannot discard the current branch: ${name}.`);
    if (!(await branchExists(name))) throw gitError("GIT_BRANCH_NOT_FOUND", `Git branch does not exist: ${name}.`);
    await execute(["branch", "-D", name], "GIT_BRANCH_DELETE_FAILED");
    emit("git.branch", { action: "discard", name });
    return { name, discarded: true };
  }

  async function execute(args, code) {
    try { return await runGit(args, { cwd: projectRoot, timeout: timeoutMs }); }
    catch (error) { const failure = gitError(code, `Git command failed: git ${args.join(" ")}.`); failure.cause = error; throw failure; }
  }

  function emit(type, payload) {
    try { onEvent({ type, timestamp: new Date().toISOString(), ...payload }); } catch { /* audit hooks must not break Git operations */ }
  }
}

async function defaultRunGit(args, options) {
  try { const result = await execFile("git", args, options); return { ...result, exitCode: 0 }; }
  catch (error) { return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", exitCode: error.code === 1 ? 1 : undefined, error }; }
}

function validateBranch(name) {
  if (typeof name !== "string" || !SAFE_BRANCH.test(name) || name.includes("//") || name.endsWith(".")) throw gitError("GIT_INVALID_BRANCH", `Invalid Git branch name: ${name ?? "<missing>"}.`);
}
function validatePaths(paths) {
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !path || path.startsWith("-") || path.includes(".."))) throw new ConfigurationError("Git paths must be safe relative paths.");
  return paths;
}
function gitError(code, message) { const error = new ConfigurationError(message); error.code = code; return error; }
