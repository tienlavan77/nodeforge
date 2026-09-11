// Summary: Runs the Claude SDK Forge tool loop without enabling built-in tools.

import process from "node:process";
import { access, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { loadNodeforgeEnv } from "./nodeforge-env.mjs";
import { readControlApiConfig } from "./control-api-config.mjs";
import { createControlApiStorage } from "./control-api-storage.mjs";
import { createControlApiAgent } from "./control-api-agent.mjs";
import { createControlApiPlatform } from "./control-api-platform.mjs";
import { createGitService } from "../src/infrastructure/git/git-service.js";
import { createStage1ReportService } from "../src/modules/workflows/stage1-report-service.js";
import { createClaudeSdkGateway } from "../src/modules/agent/claude-sdk-gateway.js";
import { createRuntimeToolGovernance } from "../src/modules/governance/runtime-tool-governance.js";
import { createForgeToolRegistry } from "../src/tools/index.js";
import { createForgeSdkMcpServer, forgeSdkToolNames } from "../src/tools/claude-sdk-forge-tools.js";

process.chdir(new URL("../..", import.meta.url).pathname);
loadNodeforgeEnv();

const includeCommit = process.argv.includes("--commit");
const config = readControlApiConfig();
const storage = await createControlApiStorage({ config });
const taskId = process.env.FORGE_TOOL_LAB_TASK ?? `TOOL-LAB-${Date.now()}`;
const executionId = `EXEC-${randomUUID()}`;
const targetPath = process.env.FORGE_TOOL_LAB_TARGET ?? "backend/tool-lab-target.txt";
const allowedPrefixes = (process.env.FORGE_TOOL_LAB_PREFIXES ?? "backend/")
  .split(",").map((value) => value.trim()).filter(Boolean);
const targetExisted = await access(targetPath).then(() => true).catch(() => false);
const agent = createControlApiAgent({ database: storage.controlDb, fileService: storage.fileService, config });
const selected = agent.agentRoleResolver.resolveAvailable("coder");
if (!selected) throw new Error("No enabled and ready coder Agent Profile is available.");
const platform = createControlApiPlatform({
  config,
  database: storage.controlDb,
  indexDb: storage.indexDb,
  fileService: storage.fileService,
  agentGateway: agent.agentGateway,
  logEvent: () => {}
});
const gitService = createGitService({ projectRoot: config.cwd });
const reportService = createStage1ReportService({
  protocolStorage: storage.protocolStorage,
  fileService: storage.fileService,
  gitService
});
const governance = createRuntimeToolGovernance();
const capabilities = ["search_code", "read_file", "write_diff", "run_test", "report_done"];
if (includeCommit) capabilities.splice(4, 0, "commit_changes");
const executionContext = governance.createExecutionContext({
  task_id: taskId,
  execution_id: executionId,
  agent_identity: { agent_id: selected.agent_id, role: selected.role },
  capabilities,
  allowed_file_paths: [targetPath, "backend/package.json"],
  allowed_prefixes: allowedPrefixes,
  lifecycle: "RUNNING",
  audit_context: { correlation_id: executionId }
});
const ticket = {
  id: taskId,
  title: "Forge SDK Tool Lab",
  objective: "Validate the Claude SDK MCP tool loop.",
  acceptance_criteria: ["run the tool loop"]
};
const toolContext = {
  ...executionContext,
  ticket,
  task: ticket,
  task_context: ticket,
  changed_paths: [targetPath],
  allowed_file_paths: [targetPath, "backend/package.json"],
  allowed_prefixes: allowedPrefixes,
  commit_id: `WORKTREE-${taskId}`,
  session_id: executionId
};
const registry = createForgeToolRegistry({
  protocolStorage: storage.protocolStorage,
  fileService: storage.fileService,
  codeSearch: platform.codeSearch,
  testService: platform.testService,
  gitService,
  reportService,
  governance
});
const mcpServers = {
  forge: createForgeSdkMcpServer({ registry, context: toolContext, includeCommit })
};
const allowedTools = forgeSdkToolNames.filter((name) => includeCommit || name !== "mcp__forge__commit_changes");
const claudeSdkGateway = createClaudeSdkGateway({
  configuration: agent.agentConfiguration,
  credentialResolver: (reference) => agent.secrets.get(reference),
  mcpServers,
  allowedTools
});

try {
  const result = await claudeSdkGateway.execute({
    agentId: selected.agent_id,
    correlationId: executionId,
    cwd: config.cwd,
    options: { tools: [] },
    prompt: buildPrompt({ taskId, targetPath, allowedPrefixes, includeCommit })
  });
  printResult({ result, selected, taskId, executionId, includeCommit });
} finally {
  if (!includeCommit && !targetExisted) await unlink(targetPath).catch(() => {});
  await storage.processLock?.release?.();
  await storage.controlDb.close?.();
  await storage.indexDb.close?.();
}

function buildPrompt({ taskId: id, targetPath: path, allowedPrefixes: prefixes, includeCommit: commit }) {
  const commitStep = commit ? `\n5. Call commit_changes once with message "Tool Lab ${id}".` : "";
  const reportNumber = commit ? 6 : 5;
  return [
    `You are running Forge Tool Lab task ${id}.`,
    "Use only the explicitly available Forge MCP tools. Built-in SDK tools are disabled; do not attempt Bash, Read, Edit, Glob, Grep, or any other built-in tool.",
    `Execute these steps in order, exactly once each:`,
    `1. Call search_code with query "backend/package.json", kind "file", limit 5, and allowed_prefixes ${JSON.stringify(prefixes)}.`,
    "2. Call read_file for path \"backend/package.json\".",
    `3. Call write_diff for path ${JSON.stringify(path)}, before_checksum null, and content exactly "tool-lab\n".`,
    "4. Call run_test with no arguments.",
    commitStep,
    `${reportNumber}. Call report_done with a concise summary of the completed steps.`,
    "Do not answer with a plan before calling the tools. Stop after report_done."
  ].filter(Boolean).join("\n");
}

function printResult({ result, selected, taskId: id, executionId: execId, includeCommit: commit }) {
  const toolCalls = result.messages.flatMap((message) => {
    const candidates = [message, message?.message, message?.content].flatMap((value) => Array.isArray(value) ? value : [value]);
    return candidates.filter((item) => item?.type === "tool_use" || item?.type === "tool_result")
      .map((item) => ({ type: item.type, name: item.name ?? item.tool_name ?? null }));
  });
  console.log(JSON.stringify({
    status: result.status,
    agent_id: selected.agent_id,
    agent_name: selected.agent_name,
    task_id: id,
    execution_id: execId,
    built_in_tools: [],
    allowed_tools: forgeSdkToolNames.filter((name) => commit || name !== "mcp__forge__commit_changes"),
    tool_events: toolCalls,
    message_count: result.messages.length
  }, null, 2));
}
