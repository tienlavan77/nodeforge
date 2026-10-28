// Verifies one result-oriented operator view while preserving complete audit
// events for recovery, agent activity, parallel projects and error diagnosis.
import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeLogger } from "../../src/core/runtime-logger.js";
import { formatTerminalLine } from "../../src/core/terminal-log-format.js";

/** Captures both public display and persisted events without touching live
 * runtime files or invoking any provider or ticket orchestration. */
function fixture() {
  const lines = [], events = [];
  const logger = createRuntimeLogger({ logEvent: (event) => events.push(event), output: { write: (line) => lines.push(line) } });
  return { lines, events, emit: (entry) => logger.emit({ timestamp: "2026-10-27T13:00:00.000Z", task_id: "TICKET-LOG", project_id: "PROJECT-A", ...entry }) };
}

test("all roles use one result line and retain tool starts in the audit only", () => {
  for (const [role, label] of [["system_engineer", "SE"], ["architecture_manager", "AM"], ["sprint_leader", "SL"], ["coder", "Coder"], ["reviewer", "Reviewer"]]) {
    const f = fixture(), payload = { agent_id: "agent", agent_name: "Example", agent_role: role, tool: "read_file", path: "backend/src/example.js" };
    f.emit({ event_name: "owner.tool_call", status: "started", payload });
    assert.equal(f.lines.length, 0);
    f.emit({ event_name: "owner.tool_call", status: "success", payload: { ...payload, duration_ms: 120 } });
    assert.equal(f.lines.length, 1);
    assert.ok(f.lines[0].startsWith(`[13:00:00] [${label}/Example] read_file; path=backend/src/example.js; duration=120ms`));
    assert.match(f.lines[0], /\[PROJECT-A\|TICKET-LOG\] - SUCCESS\n$/);
    assert.deepEqual(f.events.map((event) => event.status), ["started", "success"]);
  }
});

test("cache, bookkeeping and SDK duplicates stay persisted while their failures remain visible", () => {
  const f = fixture();
  for (const event_name of ["code_cache.read", "ticket.context_manifest_synced", "ticket.file_claims_released", "ticket.change_written", "supervisor.agent_tool_event", "owner.sdk_request_completed", "review.sdk_completed"]) f.emit({ event_name, status: "success", message: "Routine event." });
  assert.equal(f.lines.length, 0);
  assert.equal(f.events.length, 7);
  f.emit({ event_name: "code_cache.refresh_failed", status: "failed", error_code: "INDEX_UNAVAILABLE", message: "Cache refresh failed." });
  assert.equal(f.lines.length, 1);
  assert.match(f.lines[0], /INDEX_UNAVAILABLE: Cache refresh failed\..* - FAIL/);
});

test("waits, retries, Stop, handoffs and ticket completion are distinct from tool failures", () => {
  const f = fixture();
  const wait = { event_name: "ticket.waiting", status: "pending", message: "Waiting for Coder.", payload: { agent_id: "coder" } };
  f.emit(wait); f.emit(wait);
  assert.equal(f.lines.length, 1);
  assert.match(f.lines[0], / - WAIT/);
  f.emit({ event_name: "review.retry_scheduled", status: "pending", error_code: "HTTP_503", message: "Retry in 30s; press Stop to pause.", payload: { retry_after_ms: 30000 } });
  assert.match(f.lines[1], /HTTP_503:.*retry_after=30s.* - RETRY/);
  f.emit({ event_name: "agent.exchange", status: "success", message: "SL → AM; technical consultation." });
  assert.match(f.lines[2], /SL → AM.* - SUCCESS/);
  f.emit({ event_name: "task.failed", status: "failed", error_code: "TICKET_STOPPED", message: "Checkpoint retained turn=24." });
  assert.match(f.lines[3], /turn=24.* - STOP/);
  f.emit({ event_name: "terminal_bridge.status_synced", status: "success", message: "Ticket completed.", payload: { to: "done" } });
  assert.match(f.lines[4], / - DONE/);
  f.emit(wait);
  assert.equal(f.lines.length, 6, "new wait after progress is visible");
});

test("parallel projects preserve actor identity and full ticket IDs without borrowing roles", () => {
  const f = fixture(), task_id = `TICKET-${"LONG-".repeat(60)}END`;
  f.emit({ event_name: "review.started", status: "started", payload: { agent_id: "shared", agent_name: "Reviewer A", agent_role: "reviewer" } });
  f.emit({ project_id: "PROJECT-B", event_name: "owner.tool_call", status: "started", payload: { agent_id: "shared", agent_name: "Engineer B", agent_role: "system_engineer" } });
  f.emit({ event_name: "review.tool_call", task_id, status: "success", payload: { agent_id: "shared", tool: "read_lines" } });
  f.emit({ project_id: "PROJECT-B", event_name: "owner.tool_call", status: "success", payload: { agent_id: "shared", tool: "read_lines" } });
  assert.ok(f.lines[0].includes(`[Reviewer/Reviewer A] read_lines; [PROJECT-A|${task_id}] - SUCCESS`));
  assert.match(f.lines[1], /\[SE\/Engineer B\].*\[PROJECT-B\|TICKET-LOG\]/);
});

test("failure codes and result suffixes survive long messages and control-character redaction", () => {
  const line = formatTerminalLine({ timestamp: "2026-10-27T13:00:00Z", actor: "AM/Architecture", message: `secret-key\n\x1b[31m token=hidden https://gateway/private ${"x".repeat(1000)}`, result: "FAIL", secrets: ["secret-key"], taskId: "TICKET-A" });
  assert.doesNotMatch(line, /secret-key|hidden|gateway|\n/);
  assert.ok(!line.includes(String.fromCharCode(27)));
  assert.match(line, /^\[13:00:00\] \[AM\/Architecture\] \[REDACTED\]/);
  assert.match(line, /\[-\|TICKET-A\] - FAIL$/);
});

test("SDK copies are suppressed but a transport failure with no Forge receipt stays visible", () => {
  const f = fixture(), payload = { agent_id: "coder", agent_name: "Nobe", agent_role: "coder", tool: "edit_diff", error: { code: "FILE_ROLE_FORBIDDEN", message: "Read denied." } };
  f.emit({ event_name: "forge.tool_failed", status: "failed", payload });
  f.emit({ event_name: "supervisor.agent_tool_event", status: "failed", payload });
  assert.equal(f.lines.length, 1);
  assert.match(f.lines[0], /FILE_ROLE_FORBIDDEN.* - FAIL/);
  f.emit({ event_name: "supervisor.agent_tool_event", status: "failed", payload: { ...payload, error: { code: "ECONNRESET", message: "Connection lost; outcome unknown." } } });
  assert.equal(f.lines.length, 2);
  assert.match(f.lines[1], /ECONNRESET.*outcome unknown.* - FAIL/);
});

test("planning failures preserve their reason and run identity without a ticket", () => {
  const f = fixture();
  f.emit({ task_id: undefined, correlation_id: "CORR-PLAN", event_name: "supervisor.blocker_tool_call", status: "failed",
    error_code: "ENOENT", payload: { agent_role: "reviewer", tool: "read_lines", error: "Evidence is absent from the recorded environment." } });
  assert.match(f.lines[0], /\[Reviewer\] ENOENT: read_lines; error=Evidence is absent from the recorded environment\..*run=CORR-PLAN - FAIL/);
  assert.doesNotMatch(f.lines[0], /ticket=RUNTIME/);
});
