import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import test from "node:test";

const exec = promisify(execFile);
test("query-log CLI returns only filtered events across rotated files", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "forge-query-cli-"));
  const path = join(directory, "project.log");
  const event = (timestamp, name) => JSON.stringify({ timestamp, event_name: name, level: "info", status: "info", message: name, task_id: "TASK-CLI", ticket_id: "TICKET-CLI", source: "test" });
  try {
    await writeFile(`${path}.2`, `${event("2026-08-24T00:00:01.000Z", "started")}\n`);
    await writeFile(path, `${event("2026-08-24T00:00:02.000Z", "done")}\n${event("2026-08-24T00:00:03.000Z", "other").replace("TICKET-CLI", "OTHER")}\n`);
    const { stdout, stderr } = await exec(process.execPath, ["scripts/query-log.mjs", "--ticket_id", "TICKET-CLI"], { cwd: process.cwd(), env: { ...process.env, NODEFORGE_PROJECT_LOG_PATH: path } });
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout).map((entry) => entry.event_name), ["started", "done"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
