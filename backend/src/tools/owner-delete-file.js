// Lets Architecture Manager delete a stale workflow file after checking its current checksum.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";

export const ownerDeleteFileDefinition = Object.freeze({
  name: "delete_file",
  description: "Delete one role-authorized project file through Node File Service after checking its whole-file sha256. Read the file first.",
  input_schema: { type: "object", additionalProperties: false, required: ["path", "before_checksum"], properties: {
    path: { type: "string", minLength: 1, pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+" },
    before_checksum: { type: "string", pattern: "^sha256:[a-fA-F0-9]{64}$" }
  } }
});

export const ownerMoveFileDefinition = Object.freeze({
  name: "move_file",
  description: "Move or rename one role-authorized project file through Node File Service after checking its whole-file sha256. Read the source file first.",
  input_schema: { type: "object", additionalProperties: false, required: ["from_path", "to_path", "before_checksum"], properties: {
    from_path: { type: "string", minLength: 1, pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+" },
    to_path: { type: "string", minLength: 1, pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+" },
    before_checksum: { type: "string", pattern: "^sha256:[a-fA-F0-9]{64}$" }
  } }
});

// Creates a checksum-guarded delete operation for approved workflow files.
export function createOwnerDeleteFileTool({ fileService, codeCache }) {
  return Object.freeze({ name: "delete_file", async execute(input = {}, context = {}) {
    const content = await fileService.readFile({ path: input.path });
    const current = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
    if (input.before_checksum !== current) throw Object.assign(new ConfigurationError("Project file changed since it was read."), { code: "CHECKSUM_MISMATCH" });
    const result = await fileService.deleteFile({ path: input.path });
    if (!Array.isArray(context.changed_paths)) context.changed_paths = [];
    if (!context.changed_paths.includes(input.path)) context.changed_paths.push(input.path);
    codeCache?.invalidate({ path: input.path });
    return { path: input.path, deleted: true, before_sha256: current, sha256: null, ...(result && typeof result === "object" ? result : {}) };
  } });
}

// Creates a checksum-guarded move operation that relocates an authorized project file and invalidates both cache entries.
export function createOwnerMoveFileTool({ fileService, codeCache }) {
  return Object.freeze({ name: "move_file", async execute(input = {}, context = {}) {
    const fromPath = input.from_path;
    const toPath = input.to_path;
    if (typeof fromPath !== "string" || typeof toPath !== "string" || !fromPath || !toPath || fromPath === toPath) {
      throw Object.assign(new ConfigurationError("move_file requires distinct from_path and to_path strings."), { code: "INPUT_INVALID" });
    }
    const content = await fileService.readFile({ path: fromPath });
    const current = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
    if (input.before_checksum !== current) throw Object.assign(new ConfigurationError("Project file changed since it was read."), { code: "CHECKSUM_MISMATCH" });
    const move = typeof fileService.moveFile === "function"
      ? await fileService.moveFile({ from_path: fromPath, to_path: toPath })
      : await fileService.renameFile({ from: fromPath, to: toPath });
    if (!Array.isArray(context.changed_paths)) context.changed_paths = [];
    for (const changed of [fromPath, toPath]) if (!context.changed_paths.includes(changed)) context.changed_paths.push(changed);
    codeCache?.invalidate({ path: fromPath });
    codeCache?.invalidate({ path: toPath });
    return { from_path: fromPath, to_path: toPath, sha256: current, moved: true, ...move };
  } });
}
