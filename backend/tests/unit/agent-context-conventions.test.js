// Summary: Verifies convention and glossary context selection for dispatched agents.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadAgentContextConventions } from "../../src/modules/supervisor/agent-context-conventions.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("injects the Regenerate glossary mapping into ticket context", async () => {
  const result = await loadAgentContextConventions({
    projectRoot: repositoryRoot,
    ticket: { title: "Regenerate the response", objective: "Retry the failed response", acceptance_criteria: [] },
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }],
  });

  assert.match(result.text, /\| Regenerate \(response\) \| `retry`, `regen` \|/);
  assert.match(result.text, /## Code summary comments/);
  assert.match(result.text, /## Vocabulary glossary/);
  assert.doesNotMatch(result.text, /\| English \/ response language \|/);
});

test("vocabulary hints take precedence over automatic ticket matching", async () => {
  const result = await loadAgentContextConventions({
    projectRoot: repositoryRoot,
    ticket: {
      title: "Regenerate the English response",
      objective: "Retry the response with the requested locale",
      vocabulary_hints: ["English / response language"],
      acceptance_criteria: [],
      candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }],
    }
  });

  assert.match(result.text, /\| English \/ response language \|/);
  assert.doesNotMatch(result.text, /\| Regenerate \(response\) \|/);
});

test("an empty vocabulary hint list disables automatic glossary matching", async () => {
  const result = await loadAgentContextConventions({
    projectRoot: repositoryRoot,
    ticket: { title: "Regenerate the response", objective: "Retry the response", vocabulary_hints: [], acceptance_criteria: [] },
    candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }],
  });

  assert.doesNotMatch(result.text, /Relevant vocabulary mappings:/);
});
