import { createClaudeSdkGateway } from "../src/modules/agent/claude-sdk-gateway.js";

const agentId = process.env.FORGE_CODER_AGENT_ID ?? "coder";
const gatewayUrl = process.env.FORGE_GATEWAY_BASE_URL;
const gatewayToken = process.env.FORGE_GATEWAY_TOKEN;

if (!gatewayUrl) throw new Error("FORGE_GATEWAY_BASE_URL is required.");
if (!gatewayToken) throw new Error("FORGE_GATEWAY_TOKEN is required.");

const configuration = {
  getById(id) {
    if (id !== agentId) return undefined;
    return {
      agent_id: agentId,
      agent_name: process.env.FORGE_CODER_AGENT_NAME ?? "Coder",
      role: "coder",
      gateway_url: gatewayUrl,
      credential_ref: "env:FORGE_GATEWAY_TOKEN",
      enabled: true,
      status: "ready",
      ...(process.env.FORGE_CODER_MODEL ? { model: process.env.FORGE_CODER_MODEL } : {})
    };
  }
};

const gateway = createClaudeSdkGateway({
  configuration,
  credentialResolver(reference) {
    if (reference !== "env:FORGE_GATEWAY_TOKEN") throw new Error("Unexpected credential reference.");
    return gatewayToken;
  }
});

const result = await gateway.execute({
  agentId,
  correlationId: `SMOKE-${Date.now()}`,
  prompt: "Say hello in one short sentence. Do not use tools."
});

const text = result.messages
  .flatMap((message) => extractText(message))
  .join("\n")
  .trim();

console.log(`[smoke] agent ${result.agent_name} (${result.agent_id}) responded:`);
console.log(text || JSON.stringify(result.messages, null, 2));

function extractText(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(extractText);
  if (!value || typeof value !== "object") return [];
  if (typeof value.text === "string") return [value.text];
  return Object.entries(value).flatMap(([key, item]) => key === "message" || key === "content" || key === "output" ? extractText(item) : []);
}
