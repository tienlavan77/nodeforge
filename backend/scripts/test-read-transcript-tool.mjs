// Summary: Exercises read_transcript_blocks outside Supervisor and Stage-1.

import process from "node:process";
import { randomUUID } from "node:crypto";
import { loadNodeforgeEnv } from "./nodeforge-env.mjs";
import { readControlApiConfig } from "./control-api-config.mjs";
import { createControlApiStorage } from "./control-api-storage.mjs";
import { createControlApiAgent } from "./control-api-agent.mjs";
import { createForgeToolRegistry, readTranscriptBlocksDefinition } from "../src/tools/index.js";

process.chdir(new URL("../..", import.meta.url).pathname);
loadNodeforgeEnv();

const taskId = process.env.FORGE_TOOL_TEST_TASK ?? `TOOLTEST-${Date.now()}`;
const filePath = process.env.FORGE_TOOL_TEST_FILE ?? "package.json";
const dryRun = process.argv.includes("--dry-run");
const requestId = randomUUID();
const baseConfig = readControlApiConfig();
const config = { ...baseConfig, dataDir: `.forge/runtime/read-transcript-tool-${process.pid}`, protocolStorageRoot: `.forge/runtime/read-transcript-tool-${process.pid}/protocol-storage` };

const storage = await createControlApiStorage({ config });
const tools = createForgeToolRegistry({ protocolStorage: storage.protocolStorage, fileService: storage.fileService });
const transcriptBlocks = await seedTranscript(storage.protocolStorage, taskId, requestId);
const input = { block_ids: ["round-1"], rounds: [], file_paths: [filePath], include: "both", max_chars: 20000 };

try {
  const localResult = await tools.read_transcript_blocks.execute(input, {
    task_id: taskId,
    capabilities: ["read_transcript_blocks"],
    transcript_blocks: transcriptBlocks,
    allowed_file_paths: [filePath]
  });
  assertLocalResult(localResult, taskId, filePath);
  console.log(JSON.stringify({ status: "local_pass", task_id: taskId, file: filePath, block_count: localResult.blocks.length }));
  if (!dryRun) await runAgentRound(storage, input, transcriptBlocks, taskId, requestId, filePath);
} finally {
  await storage.protocolStorage.clearTask(taskId).catch(() => {});
  await storage.processLock?.release?.();
  await storage.controlDb.close?.();
  await storage.indexDb.close?.();
}

async function runAgentRound(storage, input, transcriptBlocks, taskId, requestId, filePath) {
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) throw new Error("Set OPENAI_API_KEY or ANTHROPIC_API_KEY for the real-agent test, or use --dry-run.");
  const agent = createControlApiAgent({ database: storage.controlDb, fileService: storage.fileService, config });
  const response = await agent.agentGateway.request({
    agentId: "architecture-manager",
    correlationId: `TOOL-${taskId}`,
    payload: {
      schema_version: "1.4", task_id: taskId, step_id: 1, request_id: requestId,
      conversation_mode: "hybrid", hybrid_window: 1, instruction_blocks: [{ block_id: "tool-test", content: "Call read_transcript_blocks for round 1 and the approved file, then wait for tool_result.", cacheable: false }],
      user_blocks: [{ block_id: "tool-input", content: JSON.stringify({ task_id: taskId, allowed_block_ids: ["round-1"], allowed_file_paths: [filePath] }), cacheable: false }],
      transcript_blocks: transcriptBlocks, metadata: { retry_of_step: null, previous_error: null },
      expected_output: { type: "read_transcript_blocks", transport: "function_tool" },
      tools: [{ type: "function", name: readTranscriptBlocksDefinition.name, description: readTranscriptBlocksDefinition.description, strict: true, parameters: readTranscriptBlocksDefinition.input_schema }]
    },
    tools: [{ type: "function", name: readTranscriptBlocksDefinition.name, description: readTranscriptBlocksDefinition.description, strict: true, parameters: readTranscriptBlocksDefinition.input_schema }]
  });
  const toolCall = response.tool_use ?? response.payload?.tool_use;
  if (!toolCall || toolCall.name !== "read_transcript_blocks") { console.error(JSON.stringify({ agent_response: response }, null, 2)); throw new Error(`Agent did not call read_transcript_blocks; received ${toolCall?.name ?? response.type ?? "<missing>"}.`); }
  const result = await tools.read_transcript_blocks.execute(toolCall.input ?? {}, { task_id: taskId, capabilities: ["read_transcript_blocks"], transcript_blocks: transcriptBlocks, allowed_file_paths: [filePath] });
  console.log(JSON.stringify({ status: "agent_tool_call_pass", task_id: taskId, result }));
}

async function seedTranscript(protocolStorage, taskId, requestId) {
  const blocks = [{ block_id: "round-1", round: 1, instruction: "Tool test round", response_summary: "Seed response", full_request_ref: `task/${taskId}/round_1/request`, full_response_ref: `task/${taskId}/round_1/response`, in_window: true, cacheable: false }];
  await protocolStorage.save(blocks[0].full_request_ref, { request_id: requestId, type: "task", payload: { task_id: taskId } }, { replace: true });
  await protocolStorage.save(blocks[0].full_response_ref, { request_id: randomUUID(), parent_id: requestId, type: "code_needed", payload: { files_requested: [], reason: "tool fixture" } }, { replace: true });
  return blocks;
}

function assertLocalResult(result, expectedTaskId, expectedPath) {
  if (result.task_id !== expectedTaskId || result.blocks.length !== 1 || result.files[0]?.path !== expectedPath) throw new Error("read_transcript_blocks returned an unexpected result.");
}
