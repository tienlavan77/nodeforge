// Verify agent sessions get a one-hour default while deployments can override it.
import assert from "node:assert/strict";
import test from "node:test";
import { readControlApiConfig } from "../../scripts/control-api-config.mjs";

// Keep direct agent requests and SDK tool sessions on the same default time budget.
test("agent timeouts default to 60 minutes", () => {
  const config = readControlApiConfig({ cwd: "/tmp", env: {} });
  assert.equal(config.agentTimeoutMs, 60 * 60 * 1000);
  assert.equal(config.sdkTimeoutMs, 60 * 60 * 1000);
});

// Preserve deployment-specific timeout settings for agent sessions.
test("agent timeout environment overrides remain effective", () => {
  const config = readControlApiConfig({ cwd: "/tmp", env: { NODE_AGENT_TIMEOUT_MS: "120000", NODE_SDK_AGENT_TIMEOUT_MS: "180000" } });
  assert.equal(config.agentTimeoutMs, 120000);
  assert.equal(config.sdkTimeoutMs, 180000);
});
