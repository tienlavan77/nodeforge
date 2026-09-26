// Lets Codex owner conversation agents inspect approved project paths through Forge tools.
import { ConfigurationError } from "../shared/errors.js";
import { createRgFilesTool } from "../tools/rg-files.js";
import { createSearchTreeTool } from "../tools/search-tree.js";
import { rgFilesDefinition, searchTreeDefinition } from "../tools/agent-command-tools.js";

const MAX_ROUNDS = 4;
const MAX_FILES = 60;
const TOOL_REPLY_TOKEN_LIMIT = 256;
const PRIVATE_PATH = /(^|\/)(?:\.env(?:\.|$)|(?:secret|secrets|credential|credentials|private|id_rsa|id_ed25519)(?:[._-]|$)|[^/]+\.(?:pem|key|p12|pfx)$)/i;

// Streams agent responses while fulfilling bounded, read-only project discovery requests.
export function createOwnerDiscoveryStream({ agentGateway, agentConfiguration, projectRoot, projectLogger }) {
  if (typeof agentGateway?.stream !== "function" || typeof agentConfiguration?.getById !== "function") throw new ConfigurationError("Owner discovery requires an Agent Gateway and configuration.");
  const rgFiles = createRgFilesTool({ projectRoot, logger: { emit: projectLogger } });
  const searchTree = createSearchTreeTool({ projectRoot, logger: { emit: projectLogger } });
  const tools = [rgFilesDefinition, searchTreeDefinition].map((definition) => ({ type: "function", name: definition.name, description: definition.description, parameters: definition.input_schema }));
  return stream;

  // Gives Codex owner conversations access to the read-only project discovery tools.
  async function* stream({ agentId, payload, correlationId, eventSink }) {
    const profile = agentConfiguration.getById(agentId);
    if (profile?.provider !== "codex") {
      yield* agentGateway.stream({ agentId, payload, correlationId, eventSink });
      return;
    }
    const messages = [
      { role: "developer", content: [{ type: "input_text", text: "Use search_tree when asked about project directory structure; it includes real and empty directories. Use path '.' for the project root. When asked to draw a directory tree, reproduce the tool's tree field. Use exact tool paths and counts in one concise answer without repeating conclusions. Do not describe directories as files." }] },
      { role: "user", content: [{ type: "input_text", text: payload.text }] }
    ];
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      let toolUse;
      for await (const chunk of agentGateway.stream({ agentId, payload: { messages, ...(round > 0 ? { max_output_tokens: TOOL_REPLY_TOKEN_LIMIT } : {}) }, correlationId, eventSink, tools })) {
        if (chunk.tool_use) toolUse = chunk.tool_use;
        if (chunk.text || chunk.usage) yield chunk;
      }
      if (!toolUse) return;
      if (!["rg_files", "search_tree"].includes(toolUse.name) || !toolUse.id) throw new ConfigurationError("Agent requested an unavailable discovery tool.");
      const context = { task_id: correlationId, correlation_id: correlationId, capabilities: [toolUse.name], agent_identity: { agent_id: agentId, role: profile.role }, execution_id: correlationId };
      let output;
      try {
        if (toolUse.name === "search_tree") output = await searchTree.execute(toolUse.input ?? {}, context);
        else {
          const result = await rgFiles.execute(toolUse.input ?? {}, context);
          if (result.exit_code !== 0 && result.exit_code !== 1) throw new ConfigurationError("Project file listing failed.");
          const paths = result.stdout.split("\n").filter((path) => path && !PRIVATE_PATH.test(path))
            .sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
          output = { count: paths.length, paths: paths.slice(0, MAX_FILES), truncated: paths.length > MAX_FILES };
        }
      } catch (error) {
        projectLogger?.({ event_name: `owner.discovery.${toolUse.name}_failed`, level: "error", status: "failed", message: "Owner conversation project discovery failed.", task_id: correlationId, correlation_id: correlationId, source: "owner-discovery-stream", error_code: error.code ?? "PROJECT_DISCOVERY_FAILED", payload: { agent_id: agentId } });
        output = { error_code: error.code ?? "PROJECT_DISCOVERY_FAILED", message: "Project discovery failed." };
      }
      messages.push({ type: "function_call", call_id: toolUse.id, name: toolUse.name, arguments: JSON.stringify(toolUse.input ?? {}) });
      messages.push({ type: "function_call_output", call_id: toolUse.id, output: JSON.stringify(output) });
    }
    throw new ConfigurationError("Owner conversation discovery exceeded its round limit.");
  }
}
