// Verifies role authority stays provider-independent for compatible-model Owner
// conversations and read-only AM/SL blocker investigations.
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerSdkStream } from "../../src/application/owner-sdk-stream.js";
import { ownerRoleTools } from "../../src/tools/roles/owner-role-tool-policy.js";
import { blockerRecoveryTools } from "../../src/modules/supervisor/blocker/blocker-recovery-tools.js";

// Supplies inert persistence and Git readers for registry construction without
// reading project data or making any mutation during role-authority assertions.
function files() {
  return { readFile() {}, readForIndex() {}, atomicWrite() {}, deleteFile() {}, listDirectories: async () => [], listFiles: async () => [] };
}

for (const role of ["sprint_leader", "coder", "reviewer", "linguist"]) {
  test(`Owner ${role} cannot substitute a native Codex shell for its role tools`, async () => {
    const profile = { agent_id: "AGENT", role, provider: "codex" };
    const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => profile }, fileService: files(),
      projectRoot: process.cwd(), fallbackStream: async function* () {},
      sdkGateways: { codex: { conversationMode: "thread", execute: async input => {
        await input.onEvent({ type: "item.started", item: { type: "command_execution" } });
        return { text: "must not complete" };
      } } } });
    await assert.rejects(async () => {
      for await (const chunk of stream({ agentId: "AGENT", payload: { text: "Inspect" }, correlationId: "CORR", conversationId: "CONV" }))
        assert.fail(chunk.text);
    }, { code: "TOOL_FORBIDDEN" });
  });
}

for (const provider of ["ollama", "openai"]) {
  for (const role of ["architecture_manager", "sprint_leader", "coder", "reviewer", "linguist"]) {
    test(`${provider} ${role} receives its Owner tool policy`, async () => {
      let request;
      const profile = { agent_id: "AGENT", role, provider };
      const sdk = { conversationMode: "history", builtinWebSearchAvailable: false,
        execute: async input => { request = input; return { text: "ok" }; } };
      const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => profile }, sdkGateways: { [provider]: sdk },
        fallbackStream: async function* () {}, fileService: files(), projectRoot: process.cwd(), projectLogger: () => {},
        gitService: { status: async () => "", diffWorkingTree: async () => "" } });
      for await (const chunk of stream({ agentId: "AGENT", payload: { text: "Inspect source" }, correlationId: "CORR", conversationId: "CONV" })) assert.equal(chunk.text, "ok");
      assert.deepEqual(request.options.forgeTools.definitions.map(tool => tool.name).sort(), [...ownerRoleTools(role)].sort());
      for (const name of ["run_check", "commit_changes", "push_commit"]) assert.equal(request.options.forgeTools.registry[name], undefined);
    });

    if (["architecture_manager", "sprint_leader"].includes(role)) test(`${provider} ${role} blocker investigation receives seven read-only tools`, () => {
      const tools = blockerRecoveryTools({ fileService: files(), codeCache: { read: async () => ({}) }, projectRoot: process.cwd(),
        profile: { agent_id: "AGENT", role, provider }, task_id: "TASK", correlation_id: "CORR",
        gitService: { status: async () => "", diffPatchFrom: async () => "" } });
      assert.deepEqual(tools.definitions.map(tool => tool.name).sort(), ["search_tree", "list_files", "search_text", "read_file", "read_lines", "git_status", "git_diff"].sort());
      for (const name of ["write_diff", "edit_diff", "delete_file", "run_check", "commit_changes", "push_commit"]) assert.equal(tools.registry[name], undefined);
    });
  }
}
