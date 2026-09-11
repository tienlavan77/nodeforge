import { join } from "node:path";
import { createAgentSettingsService } from "../src/application/agent-settings-service.js";
import { createNodeAgentConfiguration } from "../src/modules/agent/node-agent-configuration.js";
import { createAgentGateway } from "../src/modules/agent/agent-gateway.js";
import { createAgentProfileStore } from "../src/modules/agent/agent-profile-store.js";
import { createAgentRoleResolver } from "../src/modules/agent/agent-role-resolver.js";
import { createPersistentSecretBackend } from "../src/modules/agent/persistent-secret-backend.js";

export function createControlApiAgent({ database, fileService, config, env = process.env } = {}) {
  const profiles = createAgentProfileStore({ database });
  const agentConfiguration = createNodeAgentConfiguration({ profiles, configurationPath: join(config.dataDir, "agent-config.json"), fileService });
  const secrets = createPersistentSecretBackend({ filePath: join(config.dataDir, "secrets.vault"), encryptionKey: env.NODE_SECRET_ENCRYPTION_KEY, fileService });
  const codexBaseUrl = env.OPENAI_BASE_URL?.replace(/\/$/, "");
  const codexCredential = env.OPENAI_API_KEY;
  if (codexCredential && !secrets.get("env:OPENAI_API_KEY")) secrets.set("env:OPENAI_API_KEY", codexCredential);
  if (codexBaseUrl && codexCredential) syncArchitectureProfile({ profiles, codexBaseUrl, codexCredential, env });
  for (const existing of profiles.getAll()) {
    if (existing.provider === undefined || existing.model === undefined) {
      profiles.update({ ...existing, provider: existing.provider ?? "codex", model: existing.model ?? "", updated_at: existing.updated_at });
    }
  }
  agentConfiguration.sync();
  const agentGateway = createAgentGateway({ configuration: agentConfiguration, credentialResolver: (reference) => secrets.get(reference), timeoutMs: config.agentTimeoutMs });
  const agentSettings = createAgentSettingsService({ profiles, configuration: agentConfiguration, gateway: agentGateway, secretStore: secrets });
  const agentRoleResolver = createAgentRoleResolver({ profiles });
  return { profiles, agentConfiguration, secrets, agentGateway, agentSettings, agentRoleResolver };
}

function syncArchitectureProfile({ profiles, codexBaseUrl, codexCredential, env }) {
  const current = profiles.getAll().find((profile) => profile.role === "architecture_manager");
  const gatewayUrl = codexBaseUrl.endsWith("/responses") ? codexBaseUrl : codexBaseUrl.endsWith("/v1") ? `${codexBaseUrl}/responses` : `${codexBaseUrl}/v1/responses`;
  const model = env.NODE_AGENT_MODEL ?? "gpt-5.6-terra";
  const now = new Date().toISOString();
  if (current && (current.gateway_url.includes("gateway.example.test") || current.credential_ref.startsWith("runtime:"))) profiles.update({ ...current, gateway_url: gatewayUrl, credential_ref: "env:OPENAI_API_KEY", enabled: true, status: "ready", provider: current.provider ?? "codex", model: current.model ?? model, updated_at: now });
}
