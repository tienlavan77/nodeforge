// Verifies the UI proxy waits for long Architecture planning requests without silently disabling timeout protection.
import assert from "node:assert/strict";
import test from "node:test";

let revision = 0;

// Loads isolated Next configuration with restored environment values for each proxy timeout case.
async function configFor(context, overrides = {}) {
  const previous = { NODE_CONTROL_API_PROXY_TIMEOUT_MS: process.env.NODE_CONTROL_API_PROXY_TIMEOUT_MS, NODE_SDK_AGENT_TIMEOUT_MS: process.env.NODE_SDK_AGENT_TIMEOUT_MS };
  context.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  for (const key of Object.keys(previous)) { if (overrides[key] === undefined) delete process.env[key]; else process.env[key] = overrides[key]; }
  return (await import(`../next.config.js?proxy-test=${++revision}`)).default;
}

test("Next proxy allows the default one-hour Architecture execution plus a completion margin", async (context) => {
  const config = await configFor(context);
  assert.equal(config.experimental.proxyTimeout, 3660000);
  assert.equal(config.compress, false);
  const routes = (await config.rewrites()).afterFiles;
  assert.ok(routes.some((route) => route.source === "/forge/v1/:path*"));
});

test("Next proxy follows an explicitly configured SDK deadline", async (context) => {
  const config = await configFor(context, { NODE_SDK_AGENT_TIMEOUT_MS: "120000" });
  assert.equal(config.experimental.proxyTimeout, 180000);
});

test("deployment can explicitly configure the proxy deadline", async (context) => {
  const config = await configFor(context, { NODE_CONTROL_API_PROXY_TIMEOUT_MS: "240000" });
  assert.equal(config.experimental.proxyTimeout, 240000);
});

for (const value of ["0", "-1", "invalid", "Infinity", "1.5"]) {
  test(`Next rejects invalid proxy deadline ${value} instead of falling back to 30 seconds`, async (context) => {
    await assert.rejects(configFor(context, { NODE_CONTROL_API_PROXY_TIMEOUT_MS: value }), /positive integer/);
  });
}
