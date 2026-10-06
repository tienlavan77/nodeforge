// Verifies Architecture workspace exposes token-free pause and recovery without reusing message retry.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("Architecture workspace mounts button and double-Escape controls outside the message list", async () => {
  const page = await readFile("ui/nextjs/app/page.jsx", "utf8");
  const controls = await readFile("ui/nextjs/components/architecture-execution-controls.jsx", "utf8");
  const styles = await readFile("ui/nextjs/app/styles/responsive-workspace.css", "utf8");
  assert.match(page, /claude-chat-header[\s\S]*?<ArchitectureExecutionControls[\s\S]*?claude-chat-scroll/);
  assert.match(controls, /decide\("pause"\)/);
  assert.match(page, /agentTyping=\{agentTyping\}/);
  assert.match(controls, /current\?\.status === "running" \|\| \(!current && agentTyping\)/);
  assert.match(controls, /status === "pausing"/);
  assert.match(controls, /Pausing Architecture/);
  assert.doesNotMatch(controls, /window\.addEventListener\("focus", refresh\)|setTimeout\(/);
  assert.match(controls, /Check status/);
  assert.doesNotMatch(controls, /setInterval\(/);
  assert.doesNotMatch(controls, /Attempt \{current|completed steps/);
  assert.doesNotMatch(controls, /ownerToken|Owner token|architecture-owner-token/);
  assert.match(controls, /executionId && agentTyping[\s\S]*?execution_id: executionId/);
  assert.doesNotMatch(controls, /pending_tool_calls|provider_thread_id/);
  assert.match(controls, /Press Esc again within 3 seconds/);
  assert.match(controls, /event\.repeat \|\| event\.isComposing/);
  assert.match(controls, /conversations-accordion-rename-input/);
  assert.match(controls, /manual_required/);
  assert.match(controls, /reconcileOwnerExecution/);
  assert.match(controls, /can_reconcile[\s\S]*?Verify document/);
  assert.match(controls, /inFlight\.current/);
  assert.match(styles, /\.architecture-execution-controls \{ display: flex/);
});

// Verifies System chat offers the same visible pause lifecycle without exposing checkpoint internals.
test("System chat shows Pause, pausing, and recovery states without step counters", async () => {
  const page = await readFile("ui/nextjs/app/system/page.jsx", "utf8");
  const controls = await readFile("ui/nextjs/components/system-execution-controls.jsx", "utf8");
  assert.match(page, /agentTyping=\{agentTyping\}/);
  assert.match(controls, /decide\("pause"\)/);
  assert.match(controls, /currentStatus === "pausing"/);
  assert.match(controls, /Pausing System Engineer/);
  assert.doesNotMatch(controls, /window\.addEventListener\("focus", refresh\)|setTimeout\(/);
  assert.match(controls, /Check status/);
  assert.doesNotMatch(controls, /setInterval\(/);
  assert.match(controls, /System Engineer paused/);
  assert.match(controls, /inFlight\.current/);
  assert.doesNotMatch(controls, /Attempt \{|completed steps/);
});

test("chat pages request only role-specific agent lists and skip hidden dashboard loading", async () => {
  const architecture = await readFile("ui/nextjs/app/page.jsx", "utf8");
  const system = await readFile("ui/nextjs/app/system/page.jsx", "utf8");
  const eventStream = await readFile("ui/nextjs/lib/home-page-event-stream.js", "utf8");
  assert.match(architecture, /getAgents\("architecture_manager"\)/);
  assert.match(system, /getAgents\("system_engineer"\)/);
  assert.doesNotMatch(architecture, /ARCHITECTURE_CONVERSATION_ID/);
  assert.doesNotMatch(system, /ARCHITECTURE_CONVERSATION_ID/);
  assert.doesNotMatch(architecture, /loadDashboard|readSprintCache|listSprints/);
  assert.doesNotMatch(system, /PendingPlanApproval|loadDashboard:/);
  assert.doesNotMatch(architecture, /PendingPlanApproval|listPlans|listSprints|PlanReviewModal/);
  assert.match(architecture, /<ConversationProjectGit/);
  assert.match(system, /<ConversationProjectGit/);
  assert.match(eventStream, /loadDashboard\?\.\(\)/);
});
