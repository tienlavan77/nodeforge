// Preserves the exact SUMMARY used to draft an approved plan so later document edits cannot invalidate its execution.
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

// Keeps revision-scoped source bytes immutable and restores legacy copies only when their recorded checksum matches.
export function createMarkdownPlanSource({ fileService }) {
  // Rejects source corruption without changing the plan's original source identity or approval.
  const fail = (code, message) => Object.assign(new ConfigurationError(message), { code, statusCode: 409 });
  // Binds the persisted copy to the original exact UTF-8 bytes, including whitespace.
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  return { retain, read };

  // Writes one exact source copy, accepting an existing copy only when it is byte-for-byte identical.
  async function retain(plan, source) {
    if (typeof source !== "string" || hash(source) !== plan.source_sha256)
      throw fail("PLAN_SOURCE_MISMATCH", "SUMMARY does not match the plan's recorded source checksum.");
    const path = `${statePath()}/nf/plans/${plan.plan_id}/summary-r${plan.revision}.md`;
    try { await fileService.atomicCreate({ path, content: source }); }
    catch (error) {
      if (error.code !== "FILE_ALREADY_EXISTS") throw error;
      if (await fileService.readFile({ path }) !== source) throw fail("PLAN_SOURCE_MISMATCH", "Immutable SUMMARY snapshot differs from its recorded source.");
    }
    return { path, sha256: plan.source_sha256 };
  }

  // Uses the revision snapshot; legacy recovery can copy the live source only when its original checksum still matches.
  async function read(plan) {
    const path = `${statePath()}/nf/plans/${plan.plan_id}/summary-r${plan.revision}.md`;
    let source;
    try { source = await fileService.readFile({ path }); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      try { source = await fileService.readFile({ path: plan.source_path }); }
      catch (cause) { throw fail("PLAN_SOURCE_MISSING", `Original SUMMARY snapshot is unavailable: ${cause.code ?? cause.message}.`); }
      await retain(plan, source);
    }
    if (hash(source) !== plan.source_sha256) throw fail("PLAN_SOURCE_MISMATCH", "Immutable SUMMARY snapshot no longer matches its recorded checksum.");
    return source;
  }
}
