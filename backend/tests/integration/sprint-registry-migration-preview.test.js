// Verifies legacy Sprint conversion and scope classification before any Registry migration writes.
import assert from "node:assert/strict";
import test from "node:test";
import { sprintMigrationFixture, PROJECT, SPRINT, REVIEW } from "../fixtures/sprint-registry-migration-fixture.mjs";
import { openSprintMigrationRuntime } from "../../scripts/sprint-registry-migration-runtime.mjs";
import { buildSprintMigrationPreview } from "../../src/application/sprint-registry-migration-preview.js";

// Builds the deterministic fixture preview through the production immutable-plan validator.
function buildLegacyPreview(sprint) {
  return buildSprintMigrationPreview({
    projectId: PROJECT,
    source: { roadmap: null, historical_sprints: [{ sequence: 42, ...sprint }], metadata: [{ ...sprint.tickets[0], latest: structuredClone(sprint.tickets[0]) }], ticket_status: [] },
    registryRecords: []
  });
}

test("preview normalizes legacy style and source sequence into the current immutable plan schema", () => {
  const legacy = structuredClone(SPRINT);
  legacy.tickets[0].style = ["frontend"];
  const manifest = buildLegacyPreview(legacy);
  assert.equal(manifest.can_apply, true);
  assert.deepEqual(manifest.entries[0].content.ticket_specs[0].implementation_type, ["frontend"]);
  assert.equal("style" in manifest.entries[0].content.ticket_specs[0], false);
});

test("preview blocks legacy multi-style tickets instead of guessing one implementation type", () => {
  const legacy = structuredClone(SPRINT);
  legacy.tickets[0].style = ["frontend", "backend"];
  const manifest = buildLegacyPreview(legacy);
  assert.equal(manifest.can_apply, false);
  assert.ok(manifest.blockers.some((item) => item.code === "SPRINT_MIGRATION_IMPLEMENTATION_TYPE_INVALID" && item.identifier === "TICKET-MIGRATION"));
});

test("preview applies an explicit reasoned legacy type decision into the pending immutable draft", () => {
  const legacy = structuredClone(SPRINT);
  legacy.tickets[0].style = ["frontend", "backend"];
  const manifest = buildSprintMigrationPreview({
    projectId: PROJECT,
    source: { roadmap: null, historical_sprints: [{ sequence: 42, ...legacy }], metadata: [{ ...legacy.tickets[0], latest: structuredClone(legacy.tickets[0]) }], ticket_status: [] },
    registryRecords: [],
    supplements: { [legacy.id]: {
      human_plan: REVIEW,
      ticket_implementation_types: { "TICKET-MIGRATION": { implementation_type: ["frontend"], rationale: "The primary user operation is pinning a conversation from the chat list; backend acceptance criteria remain unchanged in the ticket specification." } }
    } }
  });
  assert.equal(manifest.can_apply, true);
  assert.deepEqual(manifest.entries[0].content.ticket_specs[0].implementation_type, ["frontend"]);
  assert.equal(manifest.normalizations[0].rationale.includes("primary user operation"), true);
});

test("preview records exact ticket.deleted evidence for legacy tickets outside current Sprint scope", () => {
  const legacy = structuredClone(SPRINT);
  legacy.tickets[0].implementation_type = ["frontend"];
  const deleted = { ...structuredClone(legacy.tickets[0]), id: "TICKET-DELETED" };
  const manifest = buildSprintMigrationPreview({
    projectId: PROJECT,
    source: {
      roadmap: null,
      historical_sprints: [{ sequence: 42, ...legacy }],
      metadata: [{ ...deleted, latest: structuredClone(deleted) }],
      ticket_deletions: [{ project_id: PROJECT, source: "sprint-plan-service", event_type: "ticket.deleted", ticket_id: deleted.id, sprint_id: legacy.id, event_id: "EVT-DELETE-1", timestamp: "2026-10-09T00:00:00Z" }],
      ticket_status: []
    },
    registryRecords: []
  });
  assert.equal(manifest.can_apply, true);
  assert.deepEqual(manifest.excluded_tickets, [{ ticket_id: deleted.id, sprint_id: legacy.id, deletion_event_id: "EVT-DELETE-1", deleted_at: "2026-10-09T00:00:00Z" }]);
});

test("legacy retrieval and workflow metadata do not count as ticket scope drift", async (t) => {
  const fixture = await sprintMigrationFixture(); t.after(fixture.close);
  const latest = fixture.tickets.readLatest("TICKET-MIGRATION");
  fixture.tickets.update({ ticket: {
    ...latest,
    candidate_files: [{ path: "backend/src/application/ticket-crud-service.js", role: "REFERENCE" }],
    candidates_produced_by: "legacy-backfill",
    candidates_produced_at: "2026-10-09T00:00:00Z",
    status: "failed",
    last_error: "A later execution attempt failed"
  } });
  const runtime = await openSprintMigrationRuntime({ config: fixture.config, mode: "preview" });
  try {
    const manifest = await runtime.service.preview({ project_id: PROJECT });
    assert.equal(manifest.can_apply, true);
    assert.equal(manifest.blockers.some((item) => item.code === "SPRINT_MIGRATION_TICKET_DRIFT"), false);
  } finally { runtime.close(); }
});
