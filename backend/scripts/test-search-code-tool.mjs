// Summary: Exercises search_code in Tool Lab, optionally through a real Agent Gateway call.

import process from "node:process";
import { randomUUID } from "node:crypto";
import { loadNodeforgeEnv } from "./nodeforge-env.mjs";
import { readControlApiConfig } from "./control-api-config.mjs";
import { createControlApiStorage } from "./control-api-storage.mjs";
import { createControlApiAgent } from "./control-api-agent.mjs";
import { createCodeSearch } from "../src/modules/index/code-search.js";
import { createForgeToolRegistry, searchCodeDefinition } from "../src/tools/index.js";

process.chdir(new URL("../..", import.meta.url).pathname);
loadNodeforgeEnv();
const dryRun = process.argv.includes("--dry-run");
const taskId = process.env.FORGE_SEARCH_TOOL_TASK ?? `SEARCH-TOOL-${Date.now()}`;
const query = process.env.FORGE_SEARCH_TOOL_QUERY ?? "Header";
const kind = process.env.FORGE_SEARCH_TOOL_KIND ?? "file";
const allowedPrefixes = (process.env.FORGE_SEARCH_TOOL_PREFIXES ?? "frontend/").split(",").map((value) => value.trim()).filter(Boolean);
const config = { ...readControlApiConfig(), dataDir: `.forge/runtime/search-code-${process.pid}`, protocolStorageRoot: `.forge/runtime/search-code-${process.pid}/protocol-storage` };
const storage = await createControlApiStorage({ config });
const codeSearch = createCodeSearch({ database: storage.indexDb });
const tools = createForgeToolRegistry({ protocolStorage: storage.protocolStorage, fileService: storage.fileService, codeSearch });
const input = { query, kind, limit: 10, allowed_prefixes: allowedPrefixes };
const context = { task_id: taskId, capabilities: ["search_code"], allowed_prefixes: allowedPrefixes };
try {
  const local = await tools.search_code.execute(input, context);
  console.log(JSON.stringify({ status: "local_pass", task_id: taskId, kind, match_count: local.matches.length, matches: local.matches }));
  if (!dryRun) await runAgent(storage, input, context);
} finally {
  await storage.processLock?.release?.();
  await storage.controlDb.close?.();
  await storage.indexDb.close?.();
}

async function runAgent(storageRef, toolInput, toolContext) {
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) throw new Error("Set OPENAI_API_KEY or ANTHROPIC_API_KEY, or use --dry-run.");
  const agent = createControlApiAgent({ database: storageRef.controlDb, fileService: storageRef.fileService, config });
  const response = await agent.agentGateway.request({
    agentId: "architecture-manager", correlationId: `SEARCH-${taskId}`,
    payload: {
      schema_version: "1.4", task_id: taskId, step_id: 1, request_id: randomUUID(), conversation_mode: "hybrid", hybrid_window: 1,
      instruction_blocks: [{ block_id: "search-tool-test", content: `Call search_code exactly once. Search ${kind} for ${query} within ${allowedPrefixes.join(", ")}.`, cacheable: false }],
      user_blocks: [{ block_id: "search-tool-input", content: JSON.stringify({ task_id: taskId, allowed_prefixes: allowedPrefixes }), cacheable: false }],
      transcript_blocks: [], metadata: { retry_of_step: null, previous_error: null }, expected_output: { type: "search_code", transport: "function_tool" },
      tools: [{ type: "function", name: searchCodeDefinition.name, description: searchCodeDefinition.description, strict: true, parameters: searchCodeDefinition.input_schema }]
    },
    tools: [{ type: "function", name: searchCodeDefinition.name, description: searchCodeDefinition.description, strict: true, parameters: searchCodeDefinition.input_schema }]
  });
  const call = response.tool_use ?? response.payload?.tool_use;
  if (!call || call.name !== "search_code") {
    console.error(JSON.stringify({ agent_response: response }, null, 2));
    throw new Error(`Agent did not call search_code; received ${call?.name ?? response.type ?? "<missing>"}.`);
  }
  const result = await tools.search_code.execute(call.input ?? toolInput, toolContext);
  console.log(JSON.stringify({ status: "agent_tool_call_pass", task_id: taskId, match_count: result.matches.length }));
}
