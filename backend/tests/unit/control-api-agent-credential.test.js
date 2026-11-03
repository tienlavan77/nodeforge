import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createControlApiAgent, syncArchitectureProfile } from "../../scripts/control-api-agent.mjs";
import { createProjectApplicationRegistry } from "../../scripts/control-api-project-applications.mjs";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createProjectRuntimeDisposal } from "../../src/modules/projects/project-runtime-disposal.js";

function profilesFor(profile) {
  const values = [profile];
  return { getAll: () => values.map((value) => ({ ...value })), update: (value) => { values[0] = value; } };
}

test("migrates the legacy shared architecture reference to a profile reference", () => {
  const profiles = profilesFor({ agent_id: "architect", role: "architecture_manager", provider: "openai", gateway_url: "https://gateway.test/v1", credential_ref: "env:OPENAI_API_KEY", enabled: true, status: "ready" });
  const secrets = new Map([["env:OPENAI_API_KEY", "profile-secret"]]);
  syncArchitectureProfile({ profiles, secrets, codexBaseUrl: "https://bootstrap.test/v1", bootstrapCredential: "bootstrap-secret", env: {} });
  const current = profiles.getAll()[0];
  assert.equal(current.credential_ref, "runtime:architect:api-key");
  assert.equal(current.gateway_url, "https://gateway.test/v1");
  assert.equal(secrets.get(current.credential_ref), "profile-secret");
  syncArchitectureProfile({ profiles, secrets, codexBaseUrl: "https://bootstrap.test/v1", bootstrapCredential: "changed-secret", env: {} });
  assert.equal(secrets.get(current.credential_ref), "profile-secret");
});

test("bootstrap keeps an existing profile credential and a configured gateway", () => {
  const profiles = profilesFor({ agent_id: "architect", role: "architecture_manager", provider: "codex", gateway_url: "https://gateway.test/v1", credential_ref: "runtime:architect:api-key", enabled: true, status: "ready" });
  const secrets = new Map([["runtime:architect:api-key", "profile-secret"]]);
  syncArchitectureProfile({ profiles, secrets, codexBaseUrl: "https://bootstrap.test/v1", bootstrapCredential: "bootstrap-secret", env: {} });
  assert.equal(profiles.getAll()[0].credential_ref, "runtime:architect:api-key");
  assert.equal(profiles.getAll()[0].gateway_url, "https://gateway.test/v1");
  assert.equal(secrets.get("runtime:architect:api-key"), "profile-secret");
});

test("placeholder gateway seeds only its own architecture credential", () => {
  const profiles = profilesFor({ agent_id: "architect", role: "architecture_manager", provider: "openai", gateway_url: "https://gateway.example.test/agent", credential_ref: "runtime:architect:api-key", enabled: false, status: "not_connected" });
  const secrets = new Map();
  syncArchitectureProfile({ profiles, secrets, codexBaseUrl: "https://bootstrap.test/v1", bootstrapCredential: "bootstrap-secret", env: {} });
  assert.equal(profiles.getAll()[0].credential_ref, "runtime:architect:api-key");
  assert.equal(secrets.get("runtime:architect:api-key"), "bootstrap-secret");
  assert.equal(secrets.has("env:OPENAI_API_KEY"), false);
});

test("external project application resolves agent gateway profiles from NodeForge database instead of empty project database", async (context) => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "control-api-shared-agent-")));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const forgeRoot = join(workspace, "nodeforge");
  const externalRoot = join(workspace, "external-project");
  const forgeDataDir = join(forgeRoot, ".forge/runtime/nf");
  const externalDataDir = join(externalRoot, ".forge/runtime/nf");
  await mkdir(forgeDataDir, { recursive: true });
  await mkdir(externalDataDir, { recursive: true });

  const forgeControlDb = await createDatabaseService({ dataDir: forgeDataDir, runtimeDir: "." });
  const externalControlDb = await createDatabaseService({ dataDir: externalDataDir, runtimeDir: "." });
  context.after(async () => {
    await externalControlDb.close();
    await forgeControlDb.close();
  });

  const sharedAgent = createControlApiAgent({
    database: forgeControlDb,
    config: { cwd: forgeRoot, dataDir: forgeDataDir, agentTimeoutMs: 5000, sdkTimeoutMs: 5000 },
    env: { NODE_SECRET_ENCRYPTION_KEY: "test-shared-agent-secret-key" }
  });
  const profileId = "52a6913b-304d-4548-8f1c-54b7d9139637";
  sharedAgent.agentSettings.save({
    agent_id: profileId,
    agent_name: "Forge System Engineer",
    role: "system_engineer",
    provider: "claude",
    model: "claude-sonnet-4-5",
    gateway_url: "https://gateway.test/v1",
    credential: "forge-secret-token",
    enabled: true,
    status: "ready"
  });

  assert.equal(sharedAgent.agentConfiguration.getById(profileId)?.agent_id, profileId);
  assert.equal(sharedAgent.agentDatabase, forgeControlDb);

  const disposal = createProjectRuntimeDisposal();
  const runtimes = new Map([
    [forgeRoot, { projectId: "PROJECT-NODEFORGE", projectRoot: forgeRoot, status: () => ({ closed: false }), close: async () => {} }],
    [externalRoot, { projectId: "PROJECT-EXTERNAL", projectRoot: externalRoot, status: () => ({ closed: false }), close: async () => {} }]
  ]);
  const lifecycle = {
    list: () => [...runtimes.values()].map((item) => ({ root: item.projectRoot, projectId: item.projectId })),
    get: async (root) => runtimes.get(root),
    registerCleanup: disposal.registerCleanup
  };

  const defaultApplication = {
    services: {
      projectId: "PROJECT-NODEFORGE",
      projectRoot: forgeRoot,
      agentConfiguration: sharedAgent.agentConfiguration,
      agentGateway: sharedAgent.agentGateway,
      agentSettings: sharedAgent.agentSettings,
      agentRoleResolver: sharedAgent.agentRoleResolver,
      sdkGateways: { claude: sharedAgent.claudeSdkGateway }
    },
    storage: {}
  };

  const registry = createProjectApplicationRegistry({
    projectLifecycle: lifecycle,
    defaultApplication,
    defaultRoot: forgeRoot,
    createStorage: async () => ({ controlDb: externalControlDb, indexDb: externalControlDb }),
    createApplication: async ({ config, storage }) => ({
      services: {
        projectId: config.projectId,
        projectRoot: config.cwd,
        controlDb: storage.controlDb,
        agentConfiguration: { getById: () => undefined },
        agentGateway: { stream: async function* () { throw new Error("Unknown Agent Gateway profile"); } }
      },
      storage,
      workers: []
    })
  });
  context.after(() => registry.close());

  const externalServices = await registry.resolve("PROJECT-EXTERNAL");
  assert.equal(externalServices.projectId, "PROJECT-EXTERNAL");
  assert.equal(externalServices.agentConfiguration.getById(profileId)?.agent_id, profileId);
  assert.equal(externalServices.agentRoleResolver.resolve("system_engineer"), profileId);
  assert.equal(externalServices.agentSettings.get(profileId).agent_id, profileId);
});
