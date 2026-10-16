// Gives SL and Architecture bounded source discovery without file writes, shell tools or network access.
import { createHash } from "node:crypto";
import { createRoleFileService } from "../../infrastructure/filesystem/file-service-role-policy.js";

// Builds a fresh read-only tool budget for one blocker investigation stage.
export function blockerRecoveryTools({ fileService, projectRoot, profile, task_id, correlation_id, projectLogger = () => {} }) {
  const files = createRoleFileService({ fileService, projectRoot, role: profile.role });
  let calls = 0;
  let bytes = 0;
  const definitions = [
    { name: "read_source", description: "Read a source window and full-file SHA-256 to verify an existing contract.", input_schema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 80 } } } },
    { name: "list_files", description: "Find existing project source files by glob; no private/runtime files are exposed.", input_schema: { type: "object", additionalProperties: false, required: ["glob"], properties: { glob: { type: "string", maxLength: 200 } } } }
  ];
  const implementations = { read_source: readSource, list_files: listFiles };
  // Audits each discovery call by name and outcome only; inspected paths, windows and content never enter the log.
  const registry = Object.fromEntries(definitions.map(({ name }) => [name, { execute: async (input) => {
    audit(name, "started");
    try {
      const result = await implementations[name](input);
      audit(name, "success");
      return result;
    } catch (error) {
      audit(name, "failed", { error_code: error.code ?? "BLOCKER_TOOL_FAILED" });
      throw error;
    }
  } }]));
  return { definitions, registry, context: { agent_identity: { agent_id: profile.agent_id, role: profile.role } } };

  // Emits one bounded human-visible audit line per discovery attempt for terminal and Coding panel streams.
  function audit(tool, status, extra = {}) {
    projectLogger({ event_name: "supervisor.blocker_tool_call", level: status === "failed" ? "error" : "info", status,
      message: `Blocker discovery ${tool} ${status}.`, task_id, correlation_id, source: "blocker-recovery-tools",
      payload: { agent_id: profile.agent_id, role: profile.role, tool, ...extra } });
  }

  // Returns bounded code evidence while retaining the checksum of the entire inspected source file.
  async function readSource({ path, offset = 1, limit = 80 }) {
    reserve();
    if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 80) throw new Error("Invalid source window.");
    const content = await files.readFile({ path });
    if (Buffer.byteLength(content) > 128_000) throw new Error("Blocker source exceeds the file evidence budget.");
    return bounded({ path, sha256: createHash("sha256").update(content).digest("hex"), offset,
      content: content.split("\n").slice(offset - 1, offset - 1 + limit).join("\n") });
  }

  // Lists a small set of role-visible files for contract discovery instead of granting command execution.
  async function listFiles({ glob }) {
    reserve();
    if (typeof glob !== "string" || !glob || glob.length > 200 || glob.startsWith("/") || glob.includes("..") || glob.includes("\\")) throw new Error("Invalid discovery glob.");
    return bounded({ paths: (await files.listFiles({ glob })).slice(0, 60) });
  }

  // Stops excessive discovery rather than letting a parked ticket consume unbounded provider context.
  function bounded(result) {
    bytes += Buffer.byteLength(JSON.stringify(result));
    if (bytes > 120_000) throw new Error("Blocker discovery budget exhausted.");
    return result;
  }

  // Counts rejected calls too so malformed or forbidden probes cannot bypass the discovery budget.
  function reserve() { calls += 1; if (calls > 30) throw new Error("Blocker discovery call budget exhausted."); }
}
