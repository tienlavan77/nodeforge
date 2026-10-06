// Verifies uncertain Architecture document mutations against precomputed, content-free file evidence.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";
import { assertRoleFileAccess } from "../infrastructure/filesystem/file-service-role-policy.js";

// Hashes a document without storing its contents in the execution checkpoint.
function checksum(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

// Reads one authorized document, representing absence explicitly for delete and new-file writes.
async function documentState(fileService, path) {
  assertRoleFileAccess("architecture_manager", "write", path);
  try { return checksum(await fileService.readFile({ path })); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

// Records the before and intended after state immediately before an Architecture write boundary.
export async function prepareArchitectureMutation(fileService, name, input) {
  if (!["write_diff", "edit_diff", "delete_file"].includes(name) || typeof input?.path !== "string") throw new ConfigurationError("Architecture mutation is not reconcilable.");
  assertRoleFileAccess("architecture_manager", name === "delete_file" ? "delete" : "write", input.path);
  const before = await documentState(fileService, input.path);
  if ((input.before_checksum ?? null) !== before) throw Object.assign(new ConfigurationError("Document changed before the mutation started."), { code: "CHECKSUM_MISMATCH" });
  if (name === "delete_file") return { before_checksum: before, expected_after_checksum: null, expected_absent: true };
  if (name === "write_diff" && typeof input.content === "string") return { before_checksum: before, expected_after_checksum: checksum(input.content) };
  if (name === "edit_diff" && typeof input.anchor === "string" && input.anchor.length && typeof input.replacement === "string") {
    const content = await fileService.readFile({ path: input.path });
    if (checksum(content) !== before) throw Object.assign(new ConfigurationError("Document changed before the edit started."), { code: "CHECKSUM_MISMATCH" });
    const parts = content.split(input.anchor);
    if (parts.length < 2 || (input.occurrence !== "all" && parts.length !== 2)) throw new ConfigurationError("Edit anchor is not unambiguous.");
    return { before_checksum: before, expected_after_checksum: checksum(parts.join(input.replacement)) };
  }
  throw new ConfigurationError("Architecture mutation has no verifiable intended result.");
}

// Confirms the physical document matches the original tool's intended result, never a user-supplied checksum.
export async function verifyArchitectureMutation(fileService, step) {
  if (!step?.path || !["write_diff", "edit_diff", "delete_file"].includes(step.tool_name)) return false;
  if (!step.expected_absent && !/^sha256:[a-f0-9]{64}$/.test(step.expected_after_checksum ?? "")) return false;
  if (step.before_checksum === (step.expected_absent ? null : step.expected_after_checksum)) return false;
  const actual = await documentState(fileService, step.path);
  return actual === (step.expected_absent ? null : step.expected_after_checksum);
}
