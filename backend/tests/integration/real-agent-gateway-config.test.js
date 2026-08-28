import assert from "node:assert/strict";
import test from "node:test";

test("all non-Architecture Agents use the configured real Responses gateway contract", async () => {
  const response = await fetch("http://127.0.0.1:3100/agents/settings");
  assert.equal(response.status, 200);
  const settings = await response.json();
  for (const agentId of ["sprint-leader", "builder", "reviewer"]) {
    const profile = settings.find((item) => item.agent_id === agentId);
    assert.ok(profile);
    assert.equal(profile.gateway_url, "https://sv.devquote.shop/v1/responses");
    assert.match(profile.credential_ref, /^runtime:/);
    assert.equal(profile.api_key_masked, "********");
    assert.equal(JSON.stringify(profile).includes("sk-"), false);
    const connection = await fetch(`http://127.0.0.1:3100/agents/${agentId}/settings/test`, { method: "POST" });
    assert.equal(connection.status, 200);
  }
});
