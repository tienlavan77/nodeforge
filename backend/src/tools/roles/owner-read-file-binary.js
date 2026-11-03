// Purpose: Provides the read_file_binary Forge tool so Architecture Manager and System Engineer can read binary project files safely by path.
// Business purpose: Enables AM and SE to inspect binary project artifacts (such as images, archives, or compiled assets) with verified sha256 checksums and base64 content while keeping binary reads unavailable to other roles.
// Technical description: Validates the input schema (path only, safe relative path), enforces AM/SE role eligibility, reads raw bytes through the role-scoped File Service with encoding: null, and returns path, sha256, size_bytes, binary: true, encoding: "base64", and content_base64.

import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

const BINARY_READ_ROLES = new Set(["architecture_manager", "system_engineer"]);

export const ownerReadFileBinaryDefinition = Object.freeze({
  name: "read_file_binary",
  description: "Read a binary project file by path and return its sha256 checksum, byte size, and base64-encoded content. Permitted only for Architecture Manager and System Engineer.",
  input_schema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: Object.freeze({
      path: Object.freeze({
        type: "string",
        minLength: 1,
        pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+"
      })
    })
  })
});

// Purpose: Creates the executable read_file_binary tool bound to a role-scoped File Service.
// Business purpose: Gives AM and SE a governed binary file reader that respects role path boundaries and returns deterministic checksums.
// Technical description: Rejects non-AM/SE roles or invalid path arguments, reads raw bytes via fileService.readFile({ path, encoding: null }), and formats the binary payload with sha256 and base64 content.
export function createOwnerReadFileBinaryTool({ fileService } = {}) {
  if (typeof fileService?.readFile !== "function") {
    throw new ConfigurationError("read_file_binary requires File Service readFile.");
  }
  return Object.freeze({
    name: "read_file_binary",
    async execute(input = {}, context = {}) {
      const role = context?.agent_identity?.role;
      if (!BINARY_READ_ROLES.has(role)) {
        throw toolError("TOOL_FORBIDDEN", "read_file_binary is permitted only for architecture_manager and system_engineer.");
      }
      if (!input || typeof input !== "object" || Object.keys(input).some((key) => key !== "path")) {
        throw toolError("INPUT_INVALID", "read_file_binary accepts path only.");
      }
      const path = validateSafePath(input.path);
      const raw = await fileService.readFile({ path, encoding: null });
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ""), "utf8");
      const sha256 = `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
      return {
        path,
        sha256,
        size_bytes: buffer.byteLength,
        binary: true,
        encoding: "base64",
        content_base64: buffer.toString("base64")
      };
    }
  });
}

// Purpose: Validates that the requested binary file path is a safe project-relative path.
// Business purpose: Prevents directory traversal or malformed paths before delegating to the File Service.
// Technical description: Rejects empty strings, absolute paths, backslashes, null bytes, and dot-segment traversal.
function validateSafePath(value) {
  if (
    typeof value !== "string"
    || !value
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("\0")
    || value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw toolError("PATH_FORBIDDEN", "Path is outside the permitted project scope.");
  }
  return value;
}

// Purpose: Constructs a typed ConfigurationError with an explicit error code.
// Business purpose: Ensures consistent error reporting across SDK and MCP tool adapters.
// Technical description: Instantiates ConfigurationError and attaches the provided error code.
function toolError(code, message) {
  const err = new ConfigurationError(message);
  err.code = code;
  return err;
}
