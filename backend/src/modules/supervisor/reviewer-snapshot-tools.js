// Provides bounded Reviewer discovery from immutable Git blobs so callers outside the diff,
// filename listings and text matches cannot silently come from a different working-tree revision.
import picomatch from "picomatch";
import { authorizeTool, isAgentPathAllowed } from "../../tools/tool-authorization.js";
import { runProjectRipgrep } from "../../tools/project-ripgrep-runner.js";
import { assertRoleFileAccess } from "../../infrastructure/filesystem/file-service-role-policy.js";
import { isDependencyPath } from "../../infrastructure/filesystem/dependency-read.js";

// Builds read-only discovery implementations that reuse ripgrep syntax only against snapshot text.
// Unsupported flags fail explicitly; no fallback invokes ripgrep over the live project directory.
export function createReviewerSnapshotTools({ source, projectRoot, environment = process.env }) {
  return { list_files: { execute: listFiles }, search_text: { execute: searchText } };

  // Lists safe snapshot paths after applying the same narrowing selectors accepted by file discovery.
  async function listFiles(input = {}, context = {}) {
    authorizeTool("list_files", context);
    if (Object.keys(input).some((key) => key !== "flags")) throw invalid("Snapshot file discovery accepts only flags.");
    const paths = await selectPaths(input.flags ?? [], context);
    return { stdout: paths.length ? `${paths.join("\n")}\n` : "", stderr: "", exit_code: paths.length ? 0 : 1, signal: null,
      review_source: { commit_sha: source.reviewCommit } };
  }

  // Searches pinned contents through stdin, preserving line numbers without consulting live files or caches.
  async function searchText(input = {}, context = {}) {
    authorizeTool("search_text", context);
    if (Object.keys(input).some((key) => !["pattern", "paths", "flags"].includes(key)) || typeof input.pattern !== "string" || !input.pattern || input.pattern.length > 1000
      || !Array.isArray(input.paths) || !input.paths.length || input.paths.length > 20) throw invalid("Snapshot search requires a bounded pattern and directory paths.");
    for (const path of input.paths) { assertRoleFileAccess("reviewer", "read", path); if (!isAgentPathAllowed(path, context)) throw invalid("Snapshot search path is outside read scope."); }
    const flags = input.flags ?? [];
    if (!Array.isArray(flags) || flags.some((flag) => typeof flag !== "string")) throw invalid("Snapshot search flags must be strings.");
    const selectors = flags.filter((flag) => /^--(?:i?glob|type(?:-not)?)=/.test(flag));
    const matching = flags.filter((flag) => !selectors.includes(flag));
    if (matching.some((flag) => !["-n", "--line-number", "-i", "--ignore-case", "-F", "--fixed-strings", "-w", "--word-regexp"].includes(flag) && !/^--max-count=[1-9]\d{0,3}$/.test(flag))) throw invalid("Unsupported snapshot search flag.");
    const paths = (await selectPaths(selectors, context)).filter((path) => input.paths.some((prefix) => path.startsWith(`${prefix}/`)));
    if (paths.length > 80) throw invalid("Snapshot search exceeds 80 files; narrow the directories or selectors.");
    const args = [...matching, "--no-filename", "--regexp", input.pattern, "--", "-"];
    const syntax = await runProjectRipgrep(projectRoot, args, environment, "", { signal: context.abortSignal });
    if (syntax.exit_code > 1 || syntax.signal) return syntax;
    let stdout = "";
    for (const path of paths) {
      authorizeTool("search_text", context);
      const file = await source.readForIndex({ path, maxBytes: 64_000 });
      const result = await runProjectRipgrep(projectRoot, args, environment, file.content, { signal: context.abortSignal });
      if (result.exit_code > 1 || result.signal || result.truncated) throw invalid("Snapshot matching failed or exceeded its output budget.");
      stdout += result.stdout.split("\n").filter(Boolean).map((line) => `${path}:${line}\n`).join("");
      if (Buffer.byteLength(stdout) > 16_000) throw invalid("Snapshot search exceeds the review output budget.");
    }
    return { stdout, stderr: "", exit_code: stdout ? 0 : 1, signal: null, review_source: { commit_sha: source.reviewCommit } };
  }

  // Applies bounded selectors to safe snapshot names before any blob is read or surfaced to the model.
  async function selectPaths(flags, context) {
    if (!Array.isArray(flags) || flags.some((flag) => typeof flag !== "string" || !(flag === "--sort=path" || /^--max-depth=\d+$/.test(flag)
      || /^--(?:i?glob)=![^!].*$/.test(flag) || /^--type(?:-not)?=[A-Za-z0-9_-]+$/.test(flag)))) throw invalid("Unsupported snapshot discovery selector.");
    const types = flags.filter((flag) => /^--type(?:-not)?=/.test(flag));
    let definitions = [];
    if (types.length) {
      const result = await runProjectRipgrep(projectRoot, ["--type-list"], environment, undefined, { signal: context.abortSignal });
      if (result.exit_code !== 0 || result.truncated) throw invalid("Snapshot type selectors are unavailable.");
      definitions = result.stdout.split("\n");
    }
    const includedTypes = [];
    const predicates = flags.map((flag) => {
      if (/^--max-depth=/.test(flag)) return (path) => path.split("/").length <= Number(flag.split("=")[1]);
      if (/^--i?glob=/.test(flag)) {
        const matches = picomatch(flag.slice(flag.indexOf("=!") + 2), { dot: true, nocase: flag.startsWith("--iglob"), matchBase: true });
        return (path) => !matches(path) && !path.split("/").some((part) => matches(part));
      }
      if (/^--type(?:-not)?=/.test(flag)) {
        const name = flag.split("=")[1];
        const definition = definitions.find((line) => line.startsWith(`${name}: `));
        if (!definition) throw invalid("Unknown snapshot file type.");
        const matches = picomatch(definition.slice(name.length + 2).split(", "), { matchBase: true });
        if (flag.startsWith("--type-not=")) return (path) => !matches(path);
        includedTypes.push(matches);
        return () => true;
      }
      return () => true;
    });
    return (await source.listFiles()).filter((path) => {
      if (isDependencyPath(path)) return false;
      try { assertRoleFileAccess("reviewer", "read", path); }
      catch (error) { if (error.code === "FILE_ROLE_FORBIDDEN") return false; throw error; }
      return isAgentPathAllowed(path, context) && predicates.every((predicate) => predicate(path))
        && (!includedTypes.length || includedTypes.some((matches) => matches(path)));
    });
  }
}

// Signals unsupported or unbounded discovery without supplying live data as an implicit fallback.
function invalid(message) {
  return Object.assign(new Error(message), { code: "REVIEW_SNAPSHOT_INPUT_INVALID" });
}
