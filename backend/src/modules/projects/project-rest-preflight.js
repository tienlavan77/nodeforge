// Classifies project roots for automatic REST intake without creating project metadata.
// Existing admission safety checks remain authoritative; filesystem diagnostics retain their
// stage, principal and recovery guidance so operators can correct unsafe host paths.
import { lstat, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { captureRoot, assertRoot, preflightCreate, preflightSource, probeStorage } from "./project-filesystem-safety.js";
import { inspectProjectStorage } from "./project-identity-safety.js";

// Distinguishes existing source, a safe new target and invalid input while preserving safety errors.
export async function preflightProject(root) {
  try {
    if (typeof root !== "string" || !root.startsWith("/")) await captureRoot(root);
    let exists = true;
    try { await lstat(root); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      exists = false;
    }
    if (!exists) {
      const target = await preflightCreate(root);
      return { status: "new", root: target.root };
    }
    const binding = await captureRoot(root);
    await preflightSource(binding);
    await inspectProjectStorage(binding);
    await probeStorage(binding.root, "root", () => assertRoot(binding));
    const entries = await readdir(binding.root);
    if (!entries.length) return { status: "new", root: binding.root };
    return { status: "existing", root: binding.root, suggestions: await readProjectSuggestions(binding.root) };
  } catch (error) {
    return { status: "invalid", code: error.code ?? "invalid_project_root", message: error.message,
      ...(error.stage ? { stage: error.stage } : {}), ...(error.guidance ? { guidance: error.guidance } : {}),
      ...(error.principal ? { principal: error.principal } : {}) };
  }
}

// Reads optional source metadata without following metadata-file links or exposing remote credentials.
async function readProjectSuggestions(root) {
  const suggestions = {};
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }));
    for (const key of ["name", "description", "author"]) if (typeof pkg[key] === "string") suggestions[key] = pkg[key];
  } catch (error) {
    if (!["ENOENT", "ELOOP"].includes(error.code) && !(error instanceof SyntaxError)) throw error;
  }
  try {
    const gitDirectory = await lstat(join(root, ".git"));
    if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) return suggestions;
    const git = await readFile(join(root, ".git", "config"), { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW });
    const remote = git.match(/\[remote "origin"\]([^[]*)/);
    const value = remote?.[1].match(/^\s*url\s*=\s*(.+)$/m)?.[1]?.trim();
    if (value && !value.includes("@") && !value.includes("?") && !value.includes("#")) suggestions.git_url = value;
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) throw error;
  }
  return suggestions;
}
