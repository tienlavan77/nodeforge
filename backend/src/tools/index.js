// Summary: Exposes Forge-owned agent tools through one provider-neutral registry.

import { createRequire } from "node:module";
import { createReadTranscriptBlocksTool } from "./read-transcript-blocks.js";
import { authorizeTool } from "./tool-authorization.js";
import { createSelectCodeGraphCandidatesTool } from "./select-code-graph-candidates.js";
import { createSearchCodeTool } from "./search-code.js";
import { createReadCodeTool } from "./read-code.js";

const require = createRequire(import.meta.url);
const readTranscriptInputSchema = require("../../../schemas/agent/tools/read-transcript-blocks.schema.json");
const selectGraphInputSchema = require("../../../schemas/agent/tools/select-code-graph-candidates.schema.json");
const searchCodeInputSchema = require("../../../schemas/agent/tools/search-code.schema.json");
const readCodeInputSchema = require("../../../schemas/agent/tools/read-code.schema.json");

export const readTranscriptBlocksDefinition = Object.freeze({
  name: "read_transcript_blocks",
  description: "Read approved transcript rounds and approved project files through Forge services.",
  input_schema: readTranscriptInputSchema
});

export const selectCodeGraphCandidatesDefinition = Object.freeze({ name: "select_code_graph_candidates", description: "Select up to four files from Node-approved Code Graph candidates.", input_schema: selectGraphInputSchema });
export const searchCodeDefinition = Object.freeze({ name: "search_code", description: "Search Forge Code Search by file or symbol and return scoped metadata only.", input_schema: searchCodeInputSchema });
export const readCodeDefinition = Object.freeze({ name: "read_code", description: "Read exactly one Node-approved file or symbol through Forge File Service.", input_schema: readCodeInputSchema });

export function createForgeToolRegistry({ protocolStorage, fileService, maxChars, codeSearch, enableReadCode = false, governance } = {}) {
  const transcriptTool = createReadTranscriptBlocksTool({ protocolStorage, fileService, maxChars });
  const graphTool = createSelectCodeGraphCandidatesTool();
  const retrievalBudgets = new Map();
  const registry = {
    read_transcript_blocks: Object.freeze({ ...transcriptTool, async execute(input, context = {}) { const scoped = withDefaultBudget(context); authorizeTool("read_transcript_blocks", scoped); return dispatch("read_transcript_blocks", transcriptTool, input, scoped); } }),
    select_code_graph_candidates: Object.freeze({ ...graphTool, async execute(input, context = {}) { const scoped = withDefaultBudget(context); authorizeTool("select_code_graph_candidates", scoped); return dispatch("select_code_graph_candidates", graphTool, input, scoped); } })
  };
  if (codeSearch?.search) {
    const searchTool = createSearchCodeTool({ codeSearch });
    registry.search_code = Object.freeze({ ...searchTool, async execute(input, context = {}) { const scoped = withDefaultBudget(context); authorizeTool("search_code", scoped); return dispatch("search_code", searchTool, input, scoped); } });
  }
  if (enableReadCode) {
    const readCodeTool = createReadCodeTool({ fileService, maxChars });
    registry.read_code = Object.freeze({ ...readCodeTool, async execute(input, context = {}) { const scoped = withDefaultBudget(context); authorizeTool("read_code", scoped); return dispatch("read_code", readCodeTool, input, scoped); } });
  }
  function withDefaultBudget(context = {}) { if (governance) return context;
    if (context.context_budget || context.retrieval_budget || context.consume_retrieval || context.consumeRetrieval) return context;
    const taskId = context.task_id ?? context.taskId;
    if (typeof taskId !== "string" || !taskId) return context;
    let budget = retrievalBudgets.get(taskId);
    if (!budget) { budget = { max_bytes: 200000, max_calls: 20, used_bytes: 0, used_calls: 0 }; retrievalBudgets.set(taskId, budget); }
    return { ...context, context_budget: budget };
  }
  function dispatch(name, tool, input, context) { if (governance?.dispatch) return governance.dispatch(name, input, context, (toolInput, toolContext) => tool.execute(toolInput, toolContext)); return tool.execute(input, context); }
  return Object.freeze(registry);
}
