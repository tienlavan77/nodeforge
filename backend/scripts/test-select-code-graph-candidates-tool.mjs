// Summary: Tests candidate selection in isolation with optional real-agent invocation.

import process from "node:process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { loadNodeforgeEnv } from "./nodeforge-env.mjs";
import { readControlApiConfig } from "./control-api-config.mjs";
import { createControlApiStorage } from "./control-api-storage.mjs";
import { createControlApiAgent } from "./control-api-agent.mjs";
import { createForgeToolRegistry, selectCodeGraphCandidatesDefinition } from "../src/tools/index.js";

process.chdir(new URL("../..", import.meta.url).pathname);
loadNodeforgeEnv();
const dryRun = process.argv.includes("--dry-run");
const taskId = process.env.FORGE_GRAPH_TOOL_TASK ?? `GRAPH-TOOL-${Date.now()}`;
const config = { ...readControlApiConfig(), dataDir: `.forge/runtime/select-graph-${process.pid}` };
const candidates = JSON.parse(process.env.FORGE_GRAPH_CANDIDATES ?? JSON.stringify([
  { path: "backend/src/modules/index/file-graph.js", score: 0.95, reason: ["graph:direct"], relations: [], confidence: "static", index_version: "IDX-test" },
  { path: "backend/src/modules/index/code-search.js", score: 0.75, reason: ["search:code"], relations: [], confidence: "static", index_version: "IDX-test" },
  { path: "backend/src/modules/index/relevant-tree.js", score: 0.62, reason: ["graph:related"], relations: [], confidence: "static", index_version: "IDX-test" }
]));
const storage = await createControlApiStorage({ config });
const tools = createForgeToolRegistry({ protocolStorage: storage.protocolStorage, fileService: storage.fileService, relevantTreeSelector: { select: () => ({ index_version: "IDX-test", tree: candidates }) } });
try {
  const input = { query: "file graph code search", context: "Find index files related to this task", limit: 2 };
  const local = await tools.select_code_graph_candidates.execute(input, { task_id: taskId, capabilities: ["select_code_graph_candidates"], task_context: { objective: "index" }, index_version: "IDX-test" });
  if (local.selected.length !== 2 || local.selected[0].score < local.selected[1].score) throw new Error("Candidate selection returned an invalid ranking.");
  console.log(JSON.stringify({ status: "local_pass", task_id: taskId, selected: local.selected }));
  if (!dryRun) await runAgent(storage, candidates, taskId);
} finally {
  await storage.processLock?.release?.();
  await storage.controlDb.close?.();
  await storage.indexDb.close?.();
}

async function runAgent(storage, candidates, taskId) {
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) throw new Error("Set OPENAI_API_KEY or ANTHROPIC_API_KEY, or use --dry-run.");
  const agent = createControlApiAgent({ database: storage.controlDb, fileService: storage.fileService, config });
  const response = await agent.agentGateway.request({ agentId: "architecture-manager", correlationId: `GRAPH-${taskId}`, payload: { request_id: randomUUID(), task_id: taskId, expected_output: { type: "select_code_graph_candidates", transport: "function_tool" }, instruction_blocks: [{ block_id: "graph-tool-test", content: `Select up to four files only from these candidates:\n${candidates.map((candidate) => `${candidate.path} score=${candidate.score}`).join("\n")}`, cacheable: false }], tools: [{ type: "function", name: selectCodeGraphCandidatesDefinition.name, description: selectCodeGraphCandidatesDefinition.description, strict: true, parameters: selectCodeGraphCandidatesDefinition.input_schema }] }, tools: [{ type: "function", name: selectCodeGraphCandidatesDefinition.name, description: selectCodeGraphCandidatesDefinition.description, strict: true, parameters: selectCodeGraphCandidatesDefinition.input_schema }] });
  const call = response.tool_use ?? response.payload?.tool_use;
  if (!call || call.name !== "select_code_graph_candidates") throw new Error(`Agent did not call select_code_graph_candidates; received ${call?.name ?? "<missing>"}.`);
  const result = await tools.select_code_graph_candidates.execute(call.input ?? {}, { task_id: taskId, capabilities: ["select_code_graph_candidates"], task_context: { objective: "index" }, index_version: "IDX-test" });
  console.log(JSON.stringify({ status: "agent_tool_call_pass", task_id: taskId, selected: result.selected }));
}
