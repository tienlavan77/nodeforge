// Checks the actual SDK prompts for AM planning and chat and SE Forge execution so
// graph-first discovery guidance cannot disappear behind a response-format branch.
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerSdkStream } from "../../src/application/owner-sdk-stream.js";

// Captures SDK requests without launching a model or accessing production conversations.
test("AM and SE receive graph-first, symbol-focused source discovery in Forge mode", async () => {
  for (const role of ["architecture_manager", "system_engineer"]) {
    for (const planning of role === "architecture_manager" ? [false, true] : [false]) {
      for (const provider of ["codex", "claude"]) {
        const requests = [];
        const stream = createOwnerSdkStream({
          agentConfiguration: { getById: () => ({ agent_id: "source-test", role, provider }) },
          sdkGateways: { [provider]: { conversationMode: provider === "codex" ? "thread" : "history",
            execute: async (request) => { requests.push(request); return { text: "done" }; } } },
          fallbackStream: async function* () {}, projectRoot: process.cwd(),
          fileService: { readFile: async () => "", readForIndex: async () => ({ content: "" }),
            atomicWrite: async () => assert.fail("unexpected write"), deleteFile: async () => assert.fail("unexpected delete"),
            listFiles: async () => [], listDirectories: async () => [] }
        });
        for await (const chunk of stream({ agentId: "source-test", payload: { text: "inspect", planning_input_only: planning },
          correlationId: "source-test", conversationId: "source-test" })) assert.equal(chunk.text, "done");
        assert.equal(requests.length, 1);
        assert.match(requests[0].prompt, /symbol_map and code_graph \(imports, imported_by, calls\)/);
        assert.match(requests[0].prompt, /prefer Read\(\{file_path,symbol\}\)/);
        assert.match(requests[0].prompt, /Do not concatenate adjacent windows/);
        assert.match(requests[0].prompt, /An empty graph with index_status stale or unavailable/);
        assert.match(requests[0].prompt, /delegate_subagent\(\{tasks:\[\{id,objective,paths\}\]\}\)/);
      }
    }
  }
});
