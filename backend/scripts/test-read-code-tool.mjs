// Summary: Exercises read_code independently, with optional real Agent Gateway invocation.

import process from "node:process";
import { randomUUID } from "node:crypto";
import { loadNodeforgeEnv } from "./nodeforge-env.mjs";
import { readControlApiConfig } from "./control-api-config.mjs";
import { createControlApiStorage } from "./control-api-storage.mjs";
import { createControlApiAgent } from "./control-api-agent.mjs";
import { createForgeToolRegistry, readCodeDefinition } from "../src/tools/index.js";

process.chdir(new URL("../..", import.meta.url).pathname);
loadNodeforgeEnv();
const dryRun = process.argv.includes("--dry-run");
const taskId = process.env.FORGE_READ_CODE_TOOL_TASK ?? `READ-CODE-TOOL-${Date.now()}`;
const path = process.env.FORGE_READ_CODE_TOOL_FILE ?? "frontend/src/components/Header.jsx";
const config = { ...readControlApiConfig(), dataDir: `.forge/runtime/read-code-${process.pid}`, protocolStorageRoot: `.forge/runtime/read-code-${process.pid}/protocol-storage` };
const storage = await createControlApiStorage({ config });
const tools = createForgeToolRegistry({ protocolStorage: storage.protocolStorage, fileService: storage.fileService, enableReadCode: true });
const input = { kind: "file", path, symbol: null, start_line: null, end_line: null, max_chars: 50000 };
const context = { task_id: taskId, capabilities: ["read_code"], allowed_file_paths: [path], allowed_symbols: [] };
try {
  const local = await tools.read_code.execute(input, context);
  console.log(JSON.stringify({ status: "local_pass", task_id: taskId, path, bytes: local.size_bytes, content_length: local.content.length }));
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
    agentId: "architecture-manager", correlationId: `READ-CODE-${taskId}`,
    payload: {
      schema_version: "1.4", task_id: taskId, step_id: 1, request_id: randomUUID(), conversation_mode: "hybrid", hybrid_window: 1,
      instruction_blocks: [{ block_id: "read-code-tool-test", content: `Call read_code exactly once for the approved file ${path}. Use kind=file, the exact path, null symbol and line fields, and max_chars=50000.`, cacheable: false }],
      user_blocks: [{ block_id: "read-code-tool-input", content: JSON.stringify({ task_id: taskId, allowed_file_paths: [path] }), cacheable: false }],
      transcript_blocks: [], metadata: { retry_of_step: null, previous_error: null }, expected_output: { type: "read_code", transport: "function_tool" },
      tools: [{ type: "function", name: readCodeDefinition.name, description: readCodeDefinition.description, strict: true, parameters: readCodeDefinition.input_schema }]
    },
    tools: [{ type: "function", name: readCodeDefinition.name, description: readCodeDefinition.description, strict: true, parameters: readCodeDefinition.input_schema }]
  });
  const call = response.tool_use ?? response.payload?.tool_use;
  if (!call || call.name !== "read_code") {
    console.error(JSON.stringify({ agent_response: response }, null, 2));
    throw new Error(`Agent did not call read_code; received ${call?.name ?? response.type ?? "<missing>"}.`);
  }
  const result = await tools.read_code.execute(call.input ?? toolInput, toolContext);
  console.log(JSON.stringify({ status: "agent_tool_call_pass", task_id: taskId, path: result.path, content_length: result.content.length }));
}
