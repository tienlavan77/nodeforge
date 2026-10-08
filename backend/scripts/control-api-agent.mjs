import { join } from "node:path";
import { createAgentSettingsService } from "../src/application/agent-settings-service.js";
import { createNodeAgentConfiguration } from "../src/modules/agent/node-agent-configuration.js";
import { createAgentGateway } from "../src/modules/agent/agent-gateway.js";
import { createClaudeSdkGateway } from "../src/modules/agent/claude-sdk-gateway.js";
import { createCodexSdkGateway } from "../src/modules/agent/codex-sdk-gateway.js";
import { createOllamaSdkGateway } from "../src/modules/agent/ollama-sdk-gateway.js";
import { createOpenAiSdkProviderFactory } from "../src/modules/agent/openai-sdk-provider.js";
import { createOpenAiSdkGateway } from "../src/modules/agent/openai-sdk-gateway.js";
import { createAgentProfileStore } from "../src/modules/agent/agent-profile-store.js";
import { createAgentRoleResolver } from "../src/modules/agent/agent-role-resolver.js";
import { createPersistentSecretBackend } from "../src/modules/agent/persistent-secret-backend.js";

export function createControlApiAgent({ database, fileService, config, env = process.env } = {}) {
  const profiles = createAgentProfileStore({ database });
  const agentConfiguration = createNodeAgentConfiguration({ profiles, configurationPath: join(config.dataDir, "agent-config.json"), fileService });
  const secrets = createPersistentSecretBackend({ filePath: join(config.dataDir, "secrets.vault"), encryptionKey: env.NODE_SECRET_ENCRYPTION_KEY, fileService });
  const codexBaseUrl = env.OPENAI_BASE_URL?.replace(/\/$/, "");
  syncArchitectureProfile({ profiles, secrets, codexBaseUrl, bootstrapCredential: env.OPENAI_API_KEY, env });
  for (const existing of profiles.getAll()) {
    if (existing.provider === undefined || existing.model === undefined) {
      profiles.update({ ...existing, provider: existing.provider ?? "codex", model: existing.model ?? "", updated_at: existing.updated_at });
    }
  }
  agentConfiguration.sync();
  const agentGateway = createAgentGateway({ configuration: agentConfiguration, credentialResolver: (reference) => secrets.get(reference), timeoutMs: config.agentTimeoutMs });
  const claudeSdkGateway = createClaudeSdkGateway({ configuration: agentConfiguration, credentialResolver: (reference) => secrets.get(reference), timeoutMs: config.sdkTimeoutMs });
  const codexSdkGateway = createCodexSdkGateway({ configuration: agentConfiguration, credentialResolver: (reference) => secrets.get(reference), timeoutMs: config.sdkTimeoutMs, codexHomeRoot: join(config.dataDir, "codex-homes") });
  const openaiSdkProviderFactory = createOpenAiSdkProviderFactory({ credentialResolver: (reference) => secrets.get(reference) });
  const openaiSdkGateway = createOpenAiSdkGateway({ providerFactory: openaiSdkProviderFactory, timeoutMs: config.sdkTimeoutMs });
  const ollamaSdkGateway = createOllamaSdkGateway({ codexSdkGateway });
  const agentSettings = createAgentSettingsService({ profiles, configuration: agentConfiguration, gateway: agentGateway, claudeSdkGateway, codexSdkGateway, openaiSdkGateway, ollamaSdkGateway, secretStore: secrets });
  const agentRoleResolver = createAgentRoleResolver({ profiles });
  return { profiles, agentConfiguration, secrets, agentGateway, claudeSdkGateway, codexSdkGateway, openaiSdkGateway, ollamaSdkGateway, agentSettings, agentRoleResolver };
}

// Migrates the bootstrap architecture credential to its own profile reference.
export function syncArchitectureProfile({ profiles, secrets, codexBaseUrl, bootstrapCredential, env }) {
  const current = profiles.getAll().find((profile) => profile.role === "architecture_manager");
  if (!current) return;
  const legacyReference = current.credential_ref === "env:OPENAI_API_KEY";
  const placeholderGateway = Boolean(codexBaseUrl && bootstrapCredential && current.gateway_url.includes("gateway.example.test"));
  if (!legacyReference && !placeholderGateway) return;
  const profileReference = legacyReference ? `runtime:${current.agent_id}:api-key` : current.credential_ref;
  if (!secrets.get(profileReference) && (legacyReference || profileReference.startsWith("runtime:"))) {
    const credential = legacyReference ? secrets.get(current.credential_ref) ?? bootstrapCredential : bootstrapCredential;
    if (!credential) return;
    secrets.set(profileReference, credential);
  }
  const gatewayUrl = placeholderGateway ? codexBaseUrl.endsWith("/responses") ? codexBaseUrl : codexBaseUrl.endsWith("/v1") ? `${codexBaseUrl}/responses` : `${codexBaseUrl}/v1/responses` : current.gateway_url;
  const model = env.NODE_AGENT_MODEL ?? "gpt-5.6-terra";
  const now = new Date().toISOString();
  profiles.update({ ...current, gateway_url: gatewayUrl, credential_ref: profileReference, enabled: placeholderGateway ? true : current.enabled, status: placeholderGateway ? "ready" : current.status, provider: current.provider ?? "codex", model: current.model ?? model, updated_at: now });
}
