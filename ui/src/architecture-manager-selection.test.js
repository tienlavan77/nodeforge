import test from "node:test";
import assert from "node:assert/strict";
import {
  architectureManagerSelection,
  readArchitectureManagerAgent,
  writeArchitectureManagerAgent,
  ARCHITECTURE_MANAGER_STORAGE_KEY
} from "./architecture-manager-selection.js";

function storage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    value(key) { return values.get(key); }
  };
}

test("persists selector changes without affecting another project", () => {
  const store = storage();
  writeArchitectureManagerAgent("one", "agent-a", store);
  writeArchitectureManagerAgent("two", "agent-b", store);
  writeArchitectureManagerAgent("one", "agent-c", store);

  assert.equal(readArchitectureManagerAgent("one", store), "agent-c");
  assert.equal(readArchitectureManagerAgent("two", store), "agent-b");
});

test("uses the stored value after reload and otherwise keeps the fallback", () => {
  const store = storage();
  assert.equal(architectureManagerSelection("one", "original", store), "original");
  writeArchitectureManagerAgent("one", "agent-a", store);
  assert.equal(architectureManagerSelection("one", "original", store), "agent-a");
});
