import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { logEvent, readLogEvents } from "../../src/core/project-log-service.js";

const valid = () => ({
  timestamp: "2026-08-24T00:00:00.000Z",
  event_name: "ticket.started",
  level: "info",
  status: "info",
  message: "Ticket dispatch started.",
  task_id: "TASK-LOG-001A",
  ticket_id: "FORGE-LOG-001a",
  source: "test"
});

test("logEvent returns a frozen schema-valid project log entry", () => {
  const event = logEvent(valid());
  assert.equal(event.event_name, "ticket.started");
  assert.equal(Object.isFrozen(event), true);
});

test("logEvent normalizes Date timestamps", () => {
  assert.equal(logEvent({ ...valid(), timestamp: new Date("2026-08-24T00:00:00.000Z") }).timestamp, "2026-08-24T00:00:00.000Z");
});

for (const field of ["timestamp", "event_name", "level", "status", "message", "task_id", "source"]) {
  test(`logEvent rejects missing ${field}`, () => {
    const entry = valid();
    delete entry[field];
    assert.throws(() => logEvent(entry), /Invalid project log event|must have required property/);
  });
}

test("logEvent rejects invalid level and status", () => {
  assert.throws(() => logEvent({ ...valid(), level: "warning" }), /Invalid project log event/);
  assert.throws(() => logEvent({ ...valid(), status: "pending" }), /Invalid project log event/);
});

test("logEvent serializes concurrent writes as complete NDJSON lines", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "forge-project-log-"));
  const path = join(directory, "project.log");
  const previous = process.env.NODEFORGE_PROJECT_LOG_PATH;
  process.env.NODEFORGE_PROJECT_LOG_PATH = path;
  try {
    await Promise.all(Array.from({ length: 100 }, (_, index) => Promise.resolve().then(() => logEvent({ ...valid(), task_id: `TASK-${index}` }))));
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 100);
    assert.doesNotThrow(() => lines.forEach((line) => JSON.parse(line)));
  } finally {
    if (previous === undefined) delete process.env.NODEFORGE_PROJECT_LOG_PATH; else process.env.NODEFORGE_PROJECT_LOG_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("logEvent rotates without overwriting the prior log", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "forge-project-log-rotate-"));
  const path = join(directory, "project.log");
  const previousPath = process.env.NODEFORGE_PROJECT_LOG_PATH;
  const previousMax = process.env.NODEFORGE_PROJECT_LOG_MAX_BYTES;
  process.env.NODEFORGE_PROJECT_LOG_PATH = path;
  process.env.NODEFORGE_PROJECT_LOG_MAX_BYTES = "200";
  try {
    logEvent({ ...valid(), task_id: "ROTATE-1", message: "x".repeat(100) });
    const first = await readFile(path, "utf8");
    logEvent({ ...valid(), task_id: "ROTATE-2", message: "y".repeat(100) });
    assert.equal(await readFile(path, "utf8"), first);
    assert.match((await readdir(directory)).join("\n"), /project\.log\.2/);
    assert.equal(JSON.parse(await readFile(`${path}.2`, "utf8")).task_id, "ROTATE-2");
    assert.ok((await stat(path)).size > 0);
  } finally {
    if (previousPath === undefined) delete process.env.NODEFORGE_PROJECT_LOG_PATH; else process.env.NODEFORGE_PROJECT_LOG_PATH = previousPath;
    if (previousMax === undefined) delete process.env.NODEFORGE_PROJECT_LOG_MAX_BYTES; else process.env.NODEFORGE_PROJECT_LOG_MAX_BYTES = previousMax;
    await rm(directory, { recursive: true, force: true });
  }
});


test("readLogEvents queries a ticket across rotated files", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "forge-project-reader-")); const path = join(directory, "project.log");
  try {
    await writeFile(`${path}.2`, JSON.stringify({ ...valid(), timestamp: "2026-08-24T00:00:01.000Z", ticket_id: "TICKET-X", event_name: "started" }) + "\n");
    await writeFile(path, JSON.stringify({ ...valid(), timestamp: "2026-08-24T00:00:03.000Z", ticket_id: "TICKET-X", event_name: "done" }) + "\n");
    const result = await readLogEvents({ logPath: path, ticket_id: "TICKET-X" });
    assert.deepEqual(result.events.map((event) => event.event_name), ["started", "done"]); assert.deepEqual(result.warnings, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("readLogEvents skips corrupt lines and reports warnings", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "forge-project-reader-corrupt-")); const path = join(directory, "project.log");
  try {
    await writeFile(path, `${JSON.stringify({ ...valid(), event_name: "before" })}\n{truncated\n${JSON.stringify({ ...valid(), event_name: "after" })}\n`);
    const warnings = []; const result = await readLogEvents({ logPath: path, onWarning: (warning) => warnings.push(warning) });
    assert.deepEqual(result.events.map((event) => event.event_name), ["before", "after"]); assert.equal(result.warnings.length, 1); assert.equal(warnings[0].line, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("readLogEvents streams large files and returns only matching events", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "forge-project-reader-large-")); const path = join(directory, "project.log");
  try {
    const lines = Array.from({ length: 20000 }, (_, i) => JSON.stringify({ ...valid(), task_id: i === 19999 ? "TARGET" : `OTHER-${i}`, timestamp: `2026-08-24T00:00:${String(i % 60).padStart(2, "0")}.000Z` })).join("\n") + "\n";
    await writeFile(path, lines);
    const result = await readLogEvents({ logPath: path, task_id: "TARGET" });
    assert.equal(result.events.length, 1); assert.equal(result.events[0].task_id, "TARGET");
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("readLogEvents filters an inclusive timestamp range", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "forge-project-reader-range-")); const path = join(directory, "project.log");
  try {
    await writeFile(path, ["2026-08-24T00:00:00.000Z", "2026-08-24T00:00:01.000Z", "2026-08-24T00:00:02.000Z"].map((timestamp) => JSON.stringify({ ...valid(), timestamp })).join("\n") + "\n");
    const result = await readLogEvents({ logPath: path, from: "2026-08-24T00:00:01.000Z", to: "2026-08-24T00:00:01.000Z" });
    assert.equal(result.events.length, 1); assert.equal(result.events[0].timestamp, "2026-08-24T00:00:01.000Z");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("records unified stream delivery failures as queryable errors", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "forge-project-log-delivery-"));
  const path = join(directory, "project.log");
  const previous = process.env.NODEFORGE_PROJECT_LOG_PATH;
  process.env.NODEFORGE_PROJECT_LOG_PATH = path;
  try {
    logEvent({
      timestamp: "2026-08-24T18:35:00.000Z",
      event_name: "system.delivery_error",
      level: "error",
      status: "failed",
      message: "Unified stream delivery failed: simulated bus failure",
      task_id: "TASK-DELIVERY-015",
      conversation_id: "CONV-BUILDER",
      source: "start-control-api",
      error_code: "STREAM_DELIVERY_FAILED",
      payload: { event_type: "node.command_result", message: "simulated bus failure", conversation_id: "CONV-BUILDER" }
    });
    const result = await readLogEvents({ logPath: path, event_name: "system.delivery_error" });
    assert.equal(result.events[0].level, "error");
    assert.equal(result.events[0].error_code, "STREAM_DELIVERY_FAILED");
  } finally {
    if (previous === undefined) delete process.env.NODEFORGE_PROJECT_LOG_PATH; else process.env.NODEFORGE_PROJECT_LOG_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
