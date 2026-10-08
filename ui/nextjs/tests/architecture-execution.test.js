// Verifies Architecture workspace exposes token-free pause and recovery without reusing message retry.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("Architecture workspace mounts button and double-Escape controls outside the message list", async () => {
  const page = await readFile("ui/nextjs/app/page.jsx", "utf8");
  const controls = await readFile("ui/nextjs/components/architecture-execution-controls.jsx", "utf8");
  const styles = await readFile("ui/nextjs/app/styles/responsive-workspace.css", "utf8");
  assert.match(page, /conversation-statusbar[\s\S]*?<ConversationProjectGit[\s\S]*?<ArchitectureExecutionControls/);
  assert.doesNotMatch(page, /claude-chat-header[\s\S]*?<ArchitectureExecutionControls[\s\S]*?claude-chat-scroll/);
  assert.match(controls, /decide\("pause"\)/);
  assert.match(page, /agentTyping=\{agentTyping\}/);
  assert.match(controls, /action === "pause" \|\| action === "reconcile" \? "interrupted"/);
  assert.doesNotMatch(controls, />Pause</);
  assert.doesNotMatch(controls, /Pausing Architecture|Check status/);
  assert.doesNotMatch(controls, /window\.addEventListener\("focus", refresh\)|setTimeout\(/);
  assert.doesNotMatch(controls, /setInterval\(/);
  assert.doesNotMatch(controls, /Attempt \{current|completed steps/);
  assert.doesNotMatch(controls, /ownerToken|Owner token|architecture-owner-token/);
  assert.match(controls, /executionId && agentTyping[\s\S]*?execution_id: executionId/);
  assert.doesNotMatch(controls, /pending_tool_calls|provider_thread_id/);
  assert.doesNotMatch(controls, /Press Esc again within 3 seconds/);
  assert.match(controls, /event\.repeat \|\| event\.isComposing/);
  assert.match(controls, /conversations-accordion-rename-input/);
  assert.match(controls, /manual_required/);
  assert.match(controls, /reconcileOwnerExecution/);
  assert.match(controls, /can_reconcile[\s\S]*?Verify document/);
  assert.match(controls, /inFlight\.current/);
  assert.match(controls, /One action interrupted/);
  assert.match(controls, /Continue interrupted action/);
  assert.match(controls, /refreshSignal/);
  assert.match(styles, /\.conversation-statusbar[\s\S]*?margin-bottom: 6px/);
  assert.match(styles, /\.architecture-execution-controls \{ display: flex/);
});

// Verifies System chat offers the same visible pause lifecycle without exposing checkpoint internals.
test("System chat shows Pause, pausing, and recovery states without step counters", async () => {
  const page = await readFile("ui/nextjs/app/system/page.jsx", "utf8");
  const controls = await readFile("ui/nextjs/components/system-execution-controls.jsx", "utf8");
  assert.match(page, /agentTyping=\{agentTyping\}/);
  assert.match(controls, /decide\("pause"\)/);
  assert.match(controls, /action === "pause" \? "interrupted"/);
  assert.doesNotMatch(controls, />Pause</);
  assert.doesNotMatch(controls, /Pausing System Engineer|Check status/);
  assert.doesNotMatch(controls, /window\.addEventListener\("focus", refresh\)|setTimeout\(/);
  assert.doesNotMatch(controls, /setInterval\(/);
  assert.match(page, /conversation-statusbar[\s\S]*?<ConversationProjectGit[\s\S]*?<SystemExecutionControls/);
  assert.doesNotMatch(page, /claude-chat-header[\s\S]*?<SystemExecutionControls[\s\S]*?claude-chat-scroll/);
  assert.match(controls, /One action interrupted/);
  assert.match(controls, /Discard interrupted action/);
  assert.match(controls, /refreshSignal/);
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
  assert.match(eventStream, /event\.conversation_id \?\? event\.payload\?\.conversation_id/);
  assert.match(eventStream, /\["failed", "paused"\]\.includes\(event\.payload\?\.status\)/);
  assert.match(eventStream, /loadDashboard\?\.\(\)/);
});
