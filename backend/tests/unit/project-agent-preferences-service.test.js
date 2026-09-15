import test from "node:test";
import assert from "node:assert/strict";
import {
  createProjectAgentPreferencesService,
  PROJECT_AGENT_PREFERENCES_KEY
} from "../../src/application/project-agent-preferences-service.js";

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    value(key) { return values.get(key); }
  };
}

test("writes and reads an agent independently per project", () => {
  const store = storage();
  const preferences = createProjectAgentPreferencesService({ storage: store });

  preferences.write("project-a", "agent-1");
  preferences.write("project-b", "agent-2");
  preferences.write("project-a", "agent-3");

  assert.equal(preferences.read("project-a"), "agent-3");
  assert.equal(preferences.read("project-b"), "agent-2");
  assert.deepEqual(JSON.parse(store.value(PROJECT_AGENT_PREFERENCES_KEY)), {
    "project-a": { agent: "agent-3" },
    "project-b": { agent: "agent-2" }
  });
});

test("keeps the original default when no project preference exists", () => {
  const preferences = createProjectAgentPreferencesService({ storage: storage() });
  assert.equal(preferences.read("missing-project"), undefined);
});
