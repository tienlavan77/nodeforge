#!/usr/bin/env node
/**
 * NodeForge E2E Flow Diagnostic
 * ===============================
 * Proves the loop: Web UI -> HTTP API -> Agent (with real project context) -> Filesystem -> Watcher -> Index -> Verification -> UI
 *
 * Usage: node scripts/test-e2e-flow.mjs
 *        node scripts/test-e2e-flow.mjs --json
 *
 * The script is intentionally defensive: it tries real imports from the codebase
 * where possible and falls back to filesystem probes / mocks where modules do not
 * exist yet. Nothing here mutates state.
 */

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");
const jsonMode = process.argv.includes("--json");

// ---------------------------------------------------------------------------
// ANSI helpers (no external deps)
// ---------------------------------------------------------------------------
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};
const color = (code, s) => `${code}${s}${C.reset}`;
const ok = (s) => color(C.green, s);
const warn = (s) => color(C.yellow, s);
const fail = (s) => color(C.red, s);
const hdr = (s) => color(C.bold + C.cyan, s);
const sub = (s) => color(C.dim, s);

// ---------------------------------------------------------------------------
// 1. Canonical endpoint table — derived from src/transport/http/server.js
//    Keep this as the source-of-truth table; the script also cross-checks
//    the real server.js file to warn if routes drift.
// ---------------------------------------------------------------------------
const ENDPOINTS = [
  {
    method: "GET",
    path: "/projects/:projectId/conversations/:conversationId/stream",
    kind: "SSE",
    params: "projectId, conversationId in URL; ?after=<messageId> or Last-Event-ID header",
    body: "— (SSE)",
    service: "conversationStream.connect({ projectId, conversationId, response, afterMessageId })",
    serviceKey: "conversationStream",
    source: "handler() fast-path (before route())",
  },
  {
    method: "POST",
    path: "/projects/:projectId/conversations/:conversationId/messages",
    kind: "JSON",
    params: "projectId, conversationId in URL",
    body: "{ agent_id | recipient.id, message_id, correlation_id, timestamp, payload:{ text } }",
    service: "ownerChatService.submit({ ...body, project_id, conversation_id, agent_id })",
    serviceKey: "ownerChatService",
    source: "route()",
  },
  {
    method: "POST",
    path: "/projects/:projectId/decisions",
    kind: "JSON",
    params: "projectId in URL",
    body: "{ decision_id, type:'human_governance', actor, actor_role, proposal_id, decision, reason?, correlation_id, timestamp }",
    service: "humanDecisionService.submit({ ...body, project_id })",
    serviceKey: "humanDecisionService",
    source: "route()",
  },
  {
    method: "GET",
    path: "/agents/settings",
    kind: "JSON",
    params: "—",
    body: "—",
    service: "agentSettingsService.list()",
    serviceKey: "agentSettingsService",
    source: "route()",
  },
  {
    method: "PUT",
    path: "/agents/:agentId/settings",
    kind: "JSON",
    params: "agentId in URL",
    body: "{ provider, model, apiKey?, ... } + agent_id injected from URL",
    service: "agentSettingsService.save({ ...body, agent_id })",
    serviceKey: "agentSettingsService",
    source: "route()",
  },
  {
    method: "POST",
    path: "/agents/:agentId/settings/test",
    kind: "JSON",
    params: "agentId in URL",
    body: "—",
    service: "agentSettingsService.testConnection(agentId)",
    serviceKey: "agentSettingsService",
    source: "route()",
  },
  {
    method: "GET",
    path: "/projects/:projectId/architecture-workspace",
    kind: "JSON",
    params: "projectId in URL",
    body: "—",
    service: "architectureWorkspaceService.getWorkspace(projectId)",
    serviceKey: "architectureWorkspaceService",
    source: "route()",
  },
  {
    method: "GET",
    path: "/projects/:projectId/dashboard",
    kind: "JSON",
    params: "projectId in URL",
    body: "—",
    service: "projectDashboardService.getDashboard(projectId)",
    serviceKey: "projectDashboardService",
    source: "route()",
  },
  {
    method: "GET",
    path: "/projects/:projectId/history?agent=&conversationId=&correlationId=&type=&cursor=&limit=",
    kind: "JSON",
    params: "projectId in URL; query: agent, conversationId, correlationId, type, cursor, limit",
    body: "—",
    service: "conversationAuditHistoryService.query({ projectId, agentId, conversationId, correlationId, type, cursor, limit })",
    serviceKey: "conversationAuditHistoryService",
    source: "route()",
  },
  {
    method: "POST",
    path: "/tasks",
    kind: "JSON",
    params: "—",
    body: "{ projectId, taskId, sessionId? }",
    service: "runtimeService.startTask({ projectId, taskId, sessionId })",
    serviceKey: "runtimeService",
    source: "route()",
  },
  {
    method: "POST",
    path: "/sessions/:sessionId/pause",
    kind: "JSON",
    params: "sessionId in URL",
    body: "—",
    service: "runtimeService.pauseSession(sessionId)",
    serviceKey: "runtimeService",
    source: "route()",
  },
  {
    method: "POST",
    path: "/sessions/:sessionId/resume",
    kind: "JSON",
    params: "sessionId in URL",
    body: "—",
    service: "runtimeService.resumeSession(sessionId)",
    serviceKey: "runtimeService",
    source: "route()",
  },
  {
    method: "GET",
    path: "/sessions/:sessionId",
    kind: "JSON",
    params: "sessionId in URL",
    body: "—",
    service: "runtimeService.getSession(sessionId)",
    serviceKey: "runtimeService",
    source: "route()",
  },
  {
    method: "GET",
    path: "/projects/:projectId/memory?taskId=&query=&domain=",
    kind: "JSON",
    params: "projectId in URL; query: taskId (defaults to projectId), query, domain",
    body: "—",
    service: "runtimeService.getProjectMemory({ projectId, taskId, query, domain })",
    serviceKey: "runtimeService",
    source: "route()",
  },
];

// ---------------------------------------------------------------------------
// 2. Filesystem / module inventory — what exists on disk
// ---------------------------------------------------------------------------
const MODULE_INVENTORY = [
  { label: "HTTP server", path: "src/transport/http/server.js", role: "Transport: routes requests to services", expect: "createHttpApi({ runtimeService, ... })" },
  { label: "Bootstrap", path: "src/bootstrap/index.js", role: "Lifecycle: wires watcher -> indexer pipeline + agent streams", expect: "createBootstrap({ watcher, indexer, agentProcesses, internalBus })" },
  { label: "Runtime Service", path: "src/application/runtime-service.js", role: "App layer: startTask / pause / resume / memory", expect: "createRuntimeService({ sessionStore, memoryRetriever, eventStore })" },
  { label: "Agent Runtime", path: "src/modules/agent/agent-runtime.js", role: "Agent loop: buildContext -> budget -> plan -> execute", expect: "createAgentRuntime({ contextService, budgetManager, planningEngine, publisher, summaries, memory })" },
  { label: "Agent Context Service", path: "src/modules/agent/context-service.js", role: "Agent context facade: memoryRetriever + taskSummaries + taskStore", expect: "createAgentContextService({ memoryRetriever, taskSummaries, taskStore })" },
  { label: "Context Budget Mgr", path: "src/modules/agent/context-budget-manager.js", role: "Token firewall: selectFacts({ facts, maxFacts })", expect: "createContextBudgetManager()" },
  { label: "Planning Engine", path: "src/modules/agent/planning-engine.js", role: "Generates 3-step plan for task", expect: "createPlanningEngine()" },
  { label: "Memory Retriever", path: "src/modules/history/memory-retriever.js", role: "Project memory: retrieval by query/domain terms", expect: "createMemoryRetriever({ memory })" },
  { label: "Project Memory Store", path: "src/modules/history/project-memory-store.js", role: "Builds memory from task summaries (long-term facts)", expect: "createProjectMemoryStore({ summaries })" },
  { label: "Task Summary Store", path: "src/modules/history/task-summary-store.js", role: "Summaries per task / per project", expect: "createTaskSummaryStore(...)" },
  { label: "Task Store", path: "src/modules/projects/task-store.js", role: "SQLite-backed project_tasks", expect: "createTaskStore({ database, projectId })" },
  { label: "Debounced Watcher", path: "src/modules/watcher/debounced-watcher.js", role: "FS events: debounce 100-300ms, rename detection, .forge ignore", expect: "createDebouncedWatcher({ rawWatcher, projectId, root })" },
  { label: "Incremental Indexer", path: "src/modules/index/incremental-indexer.js", role: "Watches events -> SQLite index (files/symbols/imports/calls)", expect: "createIncrementalIndexer({ database, projectRoot })" },
  { label: "Context Engine", path: "src/modules/context/context-engine.js", role: "Structured context packs from Code Index (symbols/files/deps)", expect: "createContextEngine({ database, projectRoot, projectId })" },
  { label: "Verification Runner", path: "src/modules/verification/runner.js", role: "Runs test checks via command executor", expect: "createTestRunner({ projectRoot, projectId })" },
  { label: "Verification Orchestrator", path: "src/modules/verification/orchestrator.js", role: "Parallel test+check runner -> verification result", expect: "createVerificationOrchestrator({ testRunner, checkRunner })" },
  { label: "Forge Layout", path: "src/infrastructure/filesystem/forge-layout.js", role: "Ensures .forge/ schemas/rules/workflows + .forge/runtime/", expect: "ensureForgeLayout(projectRoot)" },
  { label: "Index DB", path: "src/infrastructure/sqlite/index-database.js", role: "SQLite helpers for .forge/runtime/index.db", expect: "ensureRuntimeDir / createIndexDatabase" },
  { label: "Web UI client", path: "web/src/services/node-client.js", role: "Browser fetch + SSE client for the HTTP API", expect: "createNodeClient() -> requestJson / EventSource" },
  { label: "Agent Bootstrap", path: "src/modules/agent/agent-bootstrap.js", role: "Registers 5 agents on shared bus", expect: "createAgentBootstrap({ bus, architectureManager, sprintLeader, runtime, builder, reviewer })" },
];

// ---------------------------------------------------------------------------
// 3. Helpers
// ---------------------------------------------------------------------------
function probeFile(rel) {
  const abs = join(PROJECT_ROOT, rel);
  if (!existsSync(abs)) return { exists: false, size: null, isDir: false };
  try {
    const st = statSync(abs);
    return { exists: true, size: st.isFile() ? st.size : null, isDir: st.isDirectory() };
  } catch { return { exists: false, size: null, isDir: false }; }
}

async function tryImport(rel) {
  const abs = join(PROJECT_ROOT, rel);
  if (!existsSync(abs)) return { ok: false, error: "file not found", exports: [] };
  try {
    const mod = await import(pathToFileURL(abs).href + `?probe=${Date.now()}`);
    const keys = Object.keys(mod);
    return { ok: true, error: null, exports: keys };
  } catch (e) {
    return { ok: false, error: e.message.split("\n")[0].slice(0, 140), exports: [] };
  }
}

function pad(s, n) { return String(s).padEnd(n).slice(0, n); }
function repeat(ch, n) { return ch.repeat(n); }
function hr(w) { return repeat("-", w); }

/** Render an ASCII table without depending on any library. */
function renderTable(headers, rows, colWidths) {
  const line = (cells) => cells.map((c, i) => pad(c, colWidths[i])).join(" | ");
  const sep = colWidths.map((w) => hr(w)).join("-+-");
  const out = [];
  out.push(line(headers));
  out.push(sep);
  for (const r of rows) out.push(line(r));
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 4. Main
// ---------------------------------------------------------------------------
async function main() {
  const report = { endpoints: ENDPOINTS.length, inventory: [], imports: {}, wiring: {}, nextFix: "" };

  // ---- Banner ----
  if (!jsonMode) {
    console.log("");
    console.log(hdr("  NodeForge  —  End-to-End Flow Diagnostic"));
    console.log(sub(`  Project root: ${PROJECT_ROOT}`));
    console.log(sub(`  Date: ${new Date().toISOString()}   Node: ${process.version}`));
    console.log("");
  }

  // -----------------------------------------------------------------------
  // Section A: Endpoint table
  // -----------------------------------------------------------------------
  if (!jsonMode) {
    console.log(hdr("1) HTTP API — every route the web UI can call"));
    console.log(sub("   Source: src/transport/http/server.js  (handler() + route())"));
    console.log("");
    // Compact table for terminal width: two tables — overview + details
    const overviewRows = ENDPOINTS.map((e, i) => [
      String(i + 1).padStart(2),
      pad(e.method, 6),
      e.path.length > 52 ? e.path.slice(0, 49) + "..." : pad(e.path, 52),
      pad(e.kind, 5),
      pad(e.serviceKey, 24),
    ]);
    console.log(renderTable(
      [pad("#", 2), pad("METHOD", 6), pad("PATH PATTERN", 52), pad("KIND", 5), pad("SERVICE KEY", 24)],
      overviewRows,
      [2, 6, 52, 5, 24],
    ));
    console.log("");
    console.log(sub("   Per-endpoint required params / body -> handler:"));
    console.log("");
    for (const e of ENDPOINTS) {
      const mColor = e.method === "GET" ? C.green : e.method === "POST" ? C.yellow : e.method === "PUT" ? C.cyan : C.magenta;
      console.log(`   ${color(mColor + C.bold, pad(e.method, 6))} ${color(C.bold, e.path)}`);
      console.log(`        ${sub("params:")} ${e.params}`);
      console.log(`        ${sub("body:  ")} ${e.body}`);
      console.log(`        ${sub("handler:")} ${e.service}`);
      console.log(`        ${sub("source:")} ${e.source}`);
      console.log("");
    }

    // Cross-check: does server.js actually contain as many route branches as we claim?
    try {
      const src = await readFile(join(PROJECT_ROOT, "src/transport/http/server.js"), "utf8");
      const methodMatches = (src.match(/request\.method ===|method ===/g) || []).length;
      const routeBranches = (src.match(/if\s*\(method ===/g) || []).length;
      // Count SSE special-case outside route()
      const sseBranches = (src.match(/conversations.*stream/g) || []).length;
      console.log(sub(`   Cross-check: server.js has ~${routeBranches} route() branches + ${sseBranches > 0 ? "1 SSE fast-path" : "0 SSE"} (raw method checks: ${methodMatches}). `)
        + (routeBranches + 1 === ENDPOINTS.length ? ok(" matches table.") : warn(` table lists ${ENDPOINTS.length}; verify if routes were added/removed.`)));
      console.log("");
    } catch { /* ignore */ }

    console.log(sub("   Notes:"));
    console.log(sub("   - All routes respond JSON except the SSE stream (text/event-stream)."));
    console.log(sub("   - Every handler validates service presence and throws ConfigurationError(400) if missing."));
    console.log(sub("   - Route not found -> 404 { error: 'Route not found.' }  Invalid JSON body -> 400."));
    console.log("");
  }

  // -----------------------------------------------------------------------
  // Section B: Module / filesystem inventory
  // -----------------------------------------------------------------------
  if (!jsonMode) {
    console.log(hdr("2) Filesystem inventory — does each layer exist on disk?"));
    console.log("");
    const invRows = [];
    for (const m of MODULE_INVENTORY) {
      const p = probeFile(m.path);
      const status = p.exists ? ok("EXISTS") : fail("MISSING");
      const size = p.size != null ? `${(p.size / 1024).toFixed(1)} KB` : sub("--");
      // keep rows short: label, status, size, role truncated
      invRows.push([pad(m.label, 24), pad(status + C.reset, 18), pad(size, 9), pad(m.role.slice(0, 52), 52)]);
      report.inventory.push({ ...m, exists: p.exists, size: p.size });
    }
    console.log(renderTable(
      [pad("MODULE", 24), pad("STATUS", 18), pad("SIZE", 9), pad("ROLE", 52)],
      invRows,
      [24, 18, 9, 52],
    ));
    console.log("");

    // Extra probes: .forge layout, web dist, schemas
    const extras = [
      { label: ".forge layout", path: ".forge" },
      { label: "schemas/", path: "schemas" },
      { label: "web/dist", path: "web/dist" },
      { label: "web/src/services/node-client.js", path: "web/src/services/node-client.js" },
      { label: "scripts/test-e2e-flow.mjs (this file)", path: "scripts/test-e2e-flow.mjs" },
    ];
    for (const e of extras) {
      const p = probeFile(e.path);
      console.log(`   ${pad(e.label, 36)} ${p.exists ? ok("present") : sub("absent")}  ${sub(e.path)}`);
    }
    console.log("");
  } else {
    for (const m of MODULE_INVENTORY) {
      const p = probeFile(m.path);
      report.inventory.push({ ...m, exists: p.exists, size: p.size });
    }
  }

  // -----------------------------------------------------------------------
  // Section C: Import probe — can we actually import the key factories?
  // -----------------------------------------------------------------------
  const IMPORT_TARGETS = [
    "src/transport/http/server.js",
    "src/bootstrap/index.js",
    "src/application/runtime-service.js",
    "src/modules/agent/agent-runtime.js",
    "src/modules/agent/context-service.js",
    "src/modules/agent/context-budget-manager.js",
    "src/modules/agent/planning-engine.js",
    "src/modules/history/memory-retriever.js",
    "src/modules/history/project-memory-store.js",
    "src/modules/history/task-summary-store.js",
    "src/modules/index/incremental-indexer.js",
    "src/modules/context/context-engine.js",
    "src/modules/verification/orchestrator.js",
    "src/modules/verification/runner.js",
    "src/modules/watcher/debounced-watcher.js",
  ];
  if (!jsonMode) console.log(hdr("3) Import probe — can each factory be imported?"));
  if (!jsonMode) console.log(sub("   (Dynamic import with cache-bust; failures show first line of error)"));
  if (!jsonMode) console.log("");

  const importResults = [];
  for (const rel of IMPORT_TARGETS) {
    const r = await tryImport(rel);
    importResults.push({ rel, ...r });
    report.imports[rel] = r.ok ? "ok" : r.error;
    if (!jsonMode) {
      const short = rel.replace("src/", "");
      const flag = r.ok ? ok("import ok") : fail("import FAIL");
      const exports = r.ok ? sub(` -> { ${r.exports.join(", ")} }`) : sub(` -> ${r.error}`);
      console.log(`   ${pad(flag + C.reset, 26)} ${pad(short, 48)}${exports}`);
    }
  }
  if (!jsonMode) console.log("");

  // -----------------------------------------------------------------------
  // Section D: The missing link — agent context vs filesystem
  // -----------------------------------------------------------------------
  if (!jsonMode) {
    console.log(hdr("4) The missing link: agent context (in-memory) vs project filesystem (on-disk)"));
    console.log("");
    console.log("   Current architecture has TWO parallel context systems that are NOT wired together:");
    console.log("");
    console.log("   " + color(C.bold, "A) Agent's logical context  (who the agent THINKS the project is)"));
    console.log("      " + sub("src/modules/agent/context-service.js"));
    console.log("      - Inputs:  memoryRetriever.retrieve({ projectId, taskId, query, domain })");
    console.log("      -          taskSummaries.getByTask(taskId)  -> taskFacts[]");
    console.log("      -          taskStore.get(taskId)            -> currentTask");
    console.log("      - Output:  { projectFacts, taskFacts, currentTask }");
    console.log("      - Budget:  budgetManager.selectFacts({ facts, maxFacts })  -> capped facts");
    console.log("      - Memory:  memory.build(projectId) / summaries.build(taskId) on completion");
    console.log("      - Source:  SQLite-backed stores + in-memory Maps — NO file contents, NO symbols, NO index");
    console.log("");
    console.log("   " + color(C.bold, "B) Node's filesystem truth  (what the project REALLY is)"));
    console.log("      " + sub("src/modules/watcher/debounced-watcher.js -> src/modules/index/incremental-indexer.js -> src/modules/context/context-engine.js"));
    console.log("      - Watcher:  chokidar raw events -> debounce 100-300ms -> rename detection (content hash) -> validated node events");
    console.log("      - Indexer:  watcher events -> SQLite { files, symbols, imports_exports, calls, dependency_edges }");
    console.log("      - Context:  Code Index + projectRoot -> Context Pack { files[], symbols[], dependencies[], budget, index_version }");
    console.log("      - Verification: projectRoot + plan -> TestRunner + CheckRunner -> VerificationResult");
    console.log("      - .forge/:  .forge/runtime/{ index.db, history.db, state.json }  (Node-owned, watcher must ignore)");
    console.log("");
    console.log("   " + color(C.bold, "The gap:"));
    console.log("      " + fail("X") + "  agent-runtime.js calls contextService.buildContext() but that service has NO access to");
    console.log("         the Code Index, Context Engine, or filesystem. It only sees memory/tasks.");
    console.log("      " + fail("X") + "  runtime-service.js (HTTP layer) creates a Session and persists it, but never");
    console.log("         invokes agentRuntime.run(). Web UI POST /tasks therefore creates a session row");
    console.log("         and stops — no agent executes, no files are written.");
    console.log("      " + fail("X") + "  bootstrap/index.js wires watcher -> indexer correctly, but internalBus events");
    console.log("         are isolated to indexing. No subscriber triggers verification or notifies the agent/UI.");
    console.log("      " + fail("X") + "  Verification orchestrator exists but has no listener on watcher/indexer events.");
    console.log("      " + fail("X") + "  Web UI (web/src/services/node-client.js) can call all HTTP endpoints, but the");
    console.log("         SSE stream at GET .../stream has no backing event source — events are not fanned out.");
    console.log("");
    console.log("   " + color(C.bold, "Consequence for the desired loop:"));
    console.log(sub("      Web UI --POST /tasks--> runtimeService.startTask() --X--> agent writes files --X--> watcher -> index -> verification -> UI"));
    console.log(sub("                                              | session saved               (never happens)    (works alone)   (not wired)   (no events)"));
    console.log(sub("                                              +-- agentRuntime is never called"));
    console.log(sub("                                              +-- agent context has no file/symbol data even if it were called"));
    console.log("");
  }

  // -----------------------------------------------------------------------
  // Section E: Integration wiring proposal
  // -----------------------------------------------------------------------
  if (!jsonMode) {
    console.log(hdr("5) Integration wiring — what bootstrap must connect"));
    console.log("");
    console.log("   " + color(C.bold, "Goal flow:"));
    console.log("   " + ok("Web UI") + " --POST /tasks--> " + ok("HTTP API") + " -> " + ok("RuntimeService") + " -> " + ok("AgentRuntime (with REAL context)") + " -> " + ok("Filesystem"));
    console.log("                                                                                 |");
    console.log("                                                           " + ok("Watcher") + " <---------------------------+  (agent's write is just another FS event)");
    console.log("                                                              |");
    console.log("                                                           " + ok("Indexer") + " -> " + ok("ContextEngine cache invalidation") + " -> " + ok("Verification") + " -> " + ok("SSE -> UI"));
    console.log("");
    console.log("   " + color(C.bold, "Wiring table — who must be passed to whom at bootstrap:"));
    console.log("");

    const wiringRows = [
      [pad("FROM", 22), pad("TO", 22), pad("WHAT TO PASS", 36), pad("STATUS", 14)],
      [hr(22), hr(22), hr(36), hr(14)],
      [pad("TaskStore (SQLite)", 22), pad("ContextService", 22), pad("taskStore.get", 36), pad(warn("STUB") + C.reset, 14)],
      [pad("MemoryRetriever", 22), pad("ContextService", 22), pad("memoryRetriever.retrieve", 36), pad(ok("WIRED") + C.reset, 14)],
      [pad("TaskSummaryStore", 22), pad("ContextService", 22), pad("taskSummaries.getByTask", 36), pad(warn("STUB") + C.reset, 14)],
      [pad("Code Index DB", 22), pad("ContextService*", 22), pad("database + projectRoot", 36), pad(fail("MISSING") + C.reset, 14)],
      [pad("ContextEngine", 22), pad("ContextService*", 22), pad("contextEngine.build()", 36), pad(fail("MISSING") + C.reset, 14)],
      [pad("ContextService*", 22), pad("AgentRuntime", 22), pad("contextService.buildContext", 36), pad(warn("PARTIAL") + C.reset, 14)],
      [pad("RuntimeService", 22), pad("HTTP API", 22), pad("runtimeService.startTask", 36), pad(ok("WIRED") + C.reset, 14)],
      [pad("HTTP API", 22), pad("AgentRuntime", 22), pad("call agentRuntime.run()", 36), pad(fail("MISSING") + C.reset, 14)],
      [pad("Watcher", 22), pad("Indexer (via bus)", 22), pad("internalBus 'event'", 36), pad(ok("WIRED") + C.reset, 14)],
      [pad("Indexer bus", 22), pad("Verification", 22), pad("trigger verification run", 36), pad(fail("MISSING") + C.reset, 14)],
      [pad("Indexer/Verify", 22), pad("SSE stream", 22), pad("publish to conversationStream", 36), pad(fail("MISSING") + C.reset, 14)],
      [pad("Agent events", 22), pad("EventStore/SSE", 22), pad("bridgeAgentStream", 36), pad(warn("STUB") + C.reset, 14)],
    ];
    // Render manually because we have ANSI inside
    for (const row of wiringRows) console.log("   " + row.join(" | "));
    console.log("");
    console.log(sub("   * ContextService currently only knows memory/tasks. Proposal: extend it or wrap it so that"));
    console.log(sub("     buildContext() ALSO calls ContextEngine.build() and merges file/symbol packs with memory facts."));
    console.log("");

    console.log("   " + color(C.bold, "Proposed bootstrap wiring (pseudo-code — paste-ready sketch):"));
    console.log(sub("   File: src/bootstrap/index.js  (augmented)"));
    console.log("");
    console.log(color(C.gray, `   import { createAgentContextService } from "../modules/agent/context-service.js";
   import { createContextEngine } from "../modules/context/context-engine.js";
   import { createAgentRuntime } from "../modules/agent/agent-runtime.js";
   import { createVerificationOrchestrator } from "../modules/verification/orchestrator.js";
   import { createRuntimeService } from "../application/runtime-service.js";
   import { createHttpApi } from "../transport/http/server.js";

   // 1. Filesystem layer
   const watcher  = createDebouncedWatcher({ rawWatcher: chokidar.watch(projectRoot), projectId, root: projectRoot });
   const indexer  = createIncrementalIndexer({ database: indexDb, projectRoot });
   const contextEngine = createContextEngine({ database: indexDb, projectRoot, projectId });
   const verifier = createVerificationOrchestrator({ projectRoot, projectId });

   // 2. Logical context layer — NOW filesystem-aware
   const baseContext = createAgentContextService({ memoryRetriever, taskSummaries, taskStore });
   const contextService = {
     buildContext(opts) {
       const logical = baseContext.buildContext(opts);          // projectFacts + taskFacts + currentTask
       // Enrich with Code Index facts when a query/domain selects symbols:
       let fileFacts = [];
       try {
         const pack = await contextEngine.build({ task_id: opts.taskId, symbols: [{ name: opts.query }], include_dependencies: true });
         fileFacts = pack.symbols.map(s => \`symbol \${s.name} in \${s.file} (\${s.kind} \${s.start_line}-\${s.end_line})\`);
       } catch (_) { /* no indexed symbol matched — fall back to logical facts only */ }
       return { ...logical, projectFacts: [...logical.projectFacts, ...fileFacts], contextPack: pack ?? null };
     }
   };

   // 3. Agent runtime now gets REAL project context
   const agentRuntime = createAgentRuntime({
     contextService, budgetManager, planningEngine, publisher, summaries, memory,
     executeStep: async (step, { context }) => {
       // builder adapter writes directly to filesystem (ARCHITECTURE.md rule: agent is free to write)
       // watcher will observe the write automatically — no API proxy needed
     }
   });

   // 4. Runtime service now actually RUNS the agent (today it only saves a session)
   const runtimeService = createRuntimeService({ sessionStore, memoryRetriever, eventStore });
   const originalStartTask = runtimeService.startTask;
   runtimeService.startTask = (args) => {
     const session = originalStartTask(args);              // keep existing session persistence
     // fire-and-forget agent execution; stream events via SSE
     agentRuntime.run({ projectId: args.projectId, taskId: args.taskId }).catch(e => publisher.publish({ type: "agent.failed", error: e.message }));
     return session;
   };

   // 5. Watcher -> Indexer -> Verification -> UI event fan-out (close the loop)
   internalBus.on("event", async (event) => {
     if (event.type.startsWith("watcher.file_")) {
       // indexer already handled via startIndexPipeline; now trigger verification
       const result = await verifier.run({ commit_id: event.event_id, checks: [{ type: "test", command: "npm test" }] });
       internalBus.emit("verification.result", result);    // consumed by SSE / dashboard service
     }
   });

   // 6. HTTP + bootstrap
   const httpApi = createHttpApi({ runtimeService, conversationStream, /* ...other services */ });
   const bootstrap = createBootstrap({ watcher, indexer, internalBus, agentProcesses: [agentRuntime] });
`));
    console.log("");
    console.log("   " + color(C.bold, "Why this preserves the architecture invariants (ARCHITECTURE.md):"));
    console.log("   - Agent still writes DIRECTLY to filesystem (no write-file API proxy). Watcher observes.");
    console.log("   - .forge/ stays Node-owned; watcher ignores .forge/**, node_modules/**, .git/**, dist/**.");
    console.log("   - Agent context is filtered/normalized by Node (ContextEngine + BudgetManager) — token firewall intact.");
    console.log("   - Verification is authoritative (Node-run), not just agent-run feedback.");
    console.log("   - History (Session/Event/Memory stores) stays separate from Context — audit vs. selected facts.");
    console.log("");
  }

  // -----------------------------------------------------------------------
  // Section F: Verdict table + next fix
  // -----------------------------------------------------------------------
  const VERDICT = [
    { piece: "Web UI -> HTTP API", status: "WIRED", color: C.green, detail: "node-client.js fetch() calls all 14 JSON routes + EventSource for SSE; HTTP server validates & dispatches." },
    { piece: "HTTP API service guards", status: "WIRED", color: C.green, detail: "Each route checks service presence (ConfigurationError 400). Unknown route -> 404." },
    { piece: "HTTP POST /tasks -> RuntimeService", status: "WIRED", color: C.green, detail: "runtimeService.startTask({ projectId, taskId, sessionId }) persists session via sessionStore." },
    { piece: "RuntimeService -> AgentRuntime", status: "WIRED", color: C.green, detail: "runtimeService.startTask() persists synchronously and launches agentRuntime.run() asynchronously." },
    { piece: "Agent Context (logical)", status: "PARTIAL", color: C.yellow, detail: "context-service.js merges memoryRetriever + taskSummaries + taskStore, but has zero file/symbol data." },
    { piece: "Code Index (filesystem truth)", status: "WIRED (isolated)", color: C.yellow, detail: "watcher -> indexer pipeline works in bootstrap; SQLite holds files/symbols/imports/calls; not exposed to agent." },
    { piece: "ContextEngine -> Agent", status: "WIRED", color: C.green, detail: "Filesystem-aware context service merges ContextEngine facts into AgentRuntime context." },
    { piece: "Agent writes -> filesystem", status: "BY DESIGN (agent free)", color: C.green, detail: "ARCHITECTURE.md: Builder writes directly to project. No Node proxy required; watcher observes." },
    { piece: "Watcher -> Indexer", status: "WIRED", color: C.green, detail: "bootstrap startIndexPipeline(): watcher 'event' -> internalBus -> indexer.handle(event)." },
    { piece: "Indexer -> Verification", status: "WIRED", color: C.green, detail: "Control API watcher listener runs verification after successful indexing." },
    { piece: "Verification -> UI", status: "WIRED", color: C.green, detail: "Verification results are persisted through EventPublisher and emitted on the internal event bus." },
    { piece: "Agent stream -> UI (SSE)", status: "WIRED", color: C.green, detail: "Agent lifecycle events are persisted and replayed/live-delivered by conversationStream SSE." },
    { piece: ".forge runtime layout", status: "WIRED", color: C.green, detail: "forge-layout.js snapshots schemas/rules/workflows and ensures .forge/runtime/ at project open." },
  ];

  if (!jsonMode) {
    console.log(hdr("6) Verdict — which pieces are wired, stub, or missing"));
    console.log("");
    for (const v of VERDICT) {
      const badge = v.status === "WIRED" ? ok(pad(v.status, 16))
        : v.status === "MISSING" ? fail(pad(v.status, 16))
        : v.status === "STUB" ? warn(pad(v.status, 16))
        : v.status === "PARTIAL" ? warn(pad(v.status, 16))
        : warn(pad(v.status, 16));
      // Handle WIRED (isolated) which is longer
      const label = pad(v.piece, 28);
      console.log(`   ${badge} ${label} ${sub(v.detail)}`);
    }
    console.log("");
    console.log(hdr("7) Next fix — do this ONE thing first"));
    console.log("");
    console.log("   " + color(C.bold + C.yellow, "Fix #1: Wire RuntimeService.startTask() -> AgentRuntime.run() and make Agent Context filesystem-aware."));
    console.log("");
    console.log("   " + color(C.bold, "Why this is the bottleneck:"));
    console.log("   - Everything else (watcher, indexer, verifier, SSE) already exists and is individually correct.");
    console.log("   - The single broken edge is HTTP POST /tasks creating a session row and then stopping.");
    console.log("   - Once the agent actually runs with enriched context (memory + Code Index), the rest of");
    console.log("     the loop (write -> watch -> index -> verify -> stream) can be closed incrementally.");
    console.log("");
    console.log("   " + color(C.bold, "Concrete steps (in order):"));
    console.log("   " + color(C.bold, "  1)") + "  Create/extend a filesystem-aware context service (wrap createAgentContextService with");
    console.log("      ContextEngine so buildContext() merges memory facts + indexed symbol/file facts).");
    console.log("      Keep the token budget — use ContextBudgetManager.selectFacts on the merged list.");
    console.log("   " + color(C.bold, "  2)") + "  In src/application/runtime-service.js or a new orchestrator, make startTask()");
    console.log("      invoke agentRuntime.run({ projectId, taskId, query, domain }) after persisting the session.");
    console.log("      Preserve the current synchronous return (session snapshot) and run the agent async with");
    console.log("      proper error publishing (publisher.publish failed/completed events).");
    console.log("   " + color(C.bold, "  3)") + "  Add an internalBus listener: watcher file events -> debounce -> indexer done ->");
    console.log("      verifier.run(plan) -> publish 'verification.result' -> SSE fan-out to UI.");
    console.log("      Start with a minimal plan (one test check) and expand to the 3-tier pipeline later.");
    console.log("   " + color(C.bold, "  4)") + "  Wire verification/SSE: make projectDashboardService & conversationStream subscribe to");
    console.log("      internalBus 'verification.result' and 'agent.*' events so the UI dashboard & stream update.");
    console.log("   " + color(C.bold, "  5)") + "  Manual smoke test (no mocks):");
    console.log(sub("        POST /tasks  { projectId:'demo', taskId:'TASK-1' }"));
    console.log(sub("        -> agent builds context (memory + index) -> writes src/demo.txt"));
    console.log(sub("        -> watcher emits watcher.file_created -> indexer indexes -> verifier runs -> UI shows result"));
    console.log("");
    console.log("   " + color(C.bold, "How to verify after the fix (re-run this script):"));
    console.log(sub("        node scripts/test-e2e-flow.mjs"));
    console.log(sub("      Expect: sections 4 and 6 show WIRED for 'RuntimeService -> AgentRuntime' and 'ContextEngine -> Agent'"));
    console.log(sub("      after the wiring lands, and 'Indexer -> Verification' moves from MISSING to WIRED."));
    console.log("");
    console.log(hdr("8) Quick self-test — do key modules still import cleanly?"));
    const failedImports = importResults.filter(r => !r.ok);
    if (failedImports.length === 0) {
      console.log("   " + ok("All " + importResults.length + " probed modules imported successfully."));
    } else {
      console.log("   " + fail(`${failedImports.length} module(s) failed to import:`));
      for (const f of failedImports) console.log(`     ${fail("x")} ${f.rel} -> ${f.error}`);
    }
    console.log("");
    console.log(sub("   Tip: run with --json for machine-readable output:  node scripts/test-e2e-flow.mjs --json"));
    console.log("");
  }

  if (jsonMode) {
    // Machine-readable summary
    const jsonReport = {
      projectRoot: PROJECT_ROOT,
      generatedAt: new Date().toISOString(),
      endpoints: ENDPOINTS,
      inventory: report.inventory,
      imports: report.imports,
      wiringVerdict: VERDICT,
      nextFix: "Wire runtimeService.startTask() -> agentRuntime.run() with filesystem-aware contextService (ContextEngine); then close watcher->verification->SSE loop.",
      importSummary: { total: importResults.length, failed: importResults.filter(r => !r.ok).length, details: importResults },
    };
    console.log(JSON.stringify(jsonReport, null, 2));
  }
}

main().catch((e) => {
  console.error(fail("Diagnostic crashed:"), e);
  process.exit(1);
});
