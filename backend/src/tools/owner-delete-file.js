// Lets Architecture Manager delete a stale workflow file after checking its current checksum.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";

export const ownerDeleteFileDefinition = Object.freeze({
  name: "delete_file",
  description: "Delete one workflow file through Node File Service after checking its whole-file sha256. Read the file first.",
  input_schema: { type: "object", additionalProperties: false, required: ["path", "before_checksum"], properties: {
    path: { type: "string", minLength: 1 }, before_checksum: { type: "string", pattern: "^sha256:[a-fA-F0-9]{64}$" }
  } }
});

// Creates a checksum-guarded delete operation for approved workflow files.
export function createOwnerDeleteFileTool({ fileService, codeCache }) {
  return Object.freeze({ name: "delete_file", async execute(input = {}) {
    const content = await fileService.readFile({ path: input.path });
    const current = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
    if (input.before_checksum !== current) throw Object.assign(new ConfigurationError("Workflow file changed since it was read."), { code: "CHECKSUM_MISMATCH" });
    const result = await fileService.deleteFile({ path: input.path });
    codeCache?.invalidate({ path: input.path });
    return result;
  } });
}
