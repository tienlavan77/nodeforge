// Exercises the production compatible-provider ticket executor and SDK function
// registration without a network call, Git mutation or live ticket transition.
// Real bindings and checkpoints enforce role, source scope and completion gates.
import assert from "node:assert/strict";
import test from "node:test";
import { RunContext } from "@openai/agents";
import { createOpenAiSdkGateway } from "../../src/modules/agent/openai-sdk-gateway.js";
import { createOllamaSdkGateway } from "../../src/modules/agent/ollama-sdk-gateway.js";
import { createNodeforgeTaskExecutors } from "../../src/modules/supervisor/nodeforge-task-executors.js";
import { CODER_TOOL_NAMES } from "../../src/tools/engineering-tool-catalog.js";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";

// Binds fake underlying services to real SDK tool functions so tests observe
// authorization and checkpoint effects rather than fabricated provider events.
function fixture(provider, run, resume) {
  const calls = [], saved = [], serviceCalls = [];
  const profile = { agent_id: "SIGNED", agent_name: "Coder", role: "coder", provider, model: "test", reasoning: { effort: "none" } };
  const registry = Object.fromEntries(CODER_TOOL_NAMES.map(name => [name, { execute: async (args, context) => {
    serviceCalls.push({ name, args, context });
    if (name === "write_diff") context.changed_paths.push(args.path);
    return { content: "source", exit_code: 0, sha: "a".repeat(40) };
  } }]));
  const openai = createOpenAiSdkGateway({ providerFactory: { createForAgent: async selected => {
    assert.equal(selected, profile);
    return { provider: {}, profile };
  } }, AgentClass: class { constructor(options) { this.options = options; } }, runner: async (agent, input) => {
    calls.push({ agent, input });
    // Calls the SDK's actual registered function, which retains Forge context.
    const invoke = (name, args) => agent.options.tools.find(tool => tool.name === name).invoke(new RunContext(), JSON.stringify(args));
    const text = await run({ invoke, call: calls.length, agent, input, saved });
    return { finalOutput: text, history: [{ role: "user", content: "retained discovery" }, { role: "assistant", content: text }] };
  } });
  const executors = createNodeforgeTaskExecutors({ openaiSdkGateway: openai, ollamaSdkGateway: createOllamaSdkGateway({ openaiSdkGateway: openai }),
    projectRoot: process.cwd(), projectLogger: () => {}, toolRegistry: registry, runtimeGovernance: { createExecutionContext: input => input },
    checkpoints: { save: async value => saved.push(structuredClone(value)), complete: async (_id, value) => saved.push(structuredClone(value)) } });
  const request = { task_id: "TASK", request_id: "REQ", correlation_id: "CORR", ticket: { title: "Repair backend", objective: "Repair backend behavior", acceptance_criteria: ["Works"] },
    execution_context: { task_id: "TASK", approved_baseline: { file_checksums: { "backend/example.js": null } } }, payload: { ...(resume ? { resume_from: resume } : {}) } };
  return { calls, saved, serviceCalls, request, run: () => executors.runFunctionCallingTask(profile, request) };
}

for (const provider of ["ollama", "openai"]) {
  test(`${provider} Coder receives 15 tools and continues with history through real calls`, async () => {
    const f = fixture(provider, async ({ invoke, call, agent, input }) => {
      assert.deepEqual(agent.options.tools.map(tool => tool.name), CODER_TOOL_NAMES);
      assert.ok(agent.options.tools.every(tool => tool.type === "function"));
      if (call === 1) {
        await invoke("read_file", { path: "workflows/agents/coder/README.md" });
        return JSON.stringify({ kind: "work_progress", subject: "Discovery complete", payload: { status: "discovery_complete", next_action: "implement", summary: "Source found", remaining_work: ["Apply repair"] }, evidence: [] });
      }
      assert.ok(Array.isArray(input));
      assert.equal(input[0].content, "retained discovery");
      assert.match(input.at(-1).content, /Node accepted work_progress/);
      await invoke("write_diff", { path: "backend/example.js", content: "fixed", before_checksum: null });
      await invoke("run_check", { type: "test", command: "node --test backend/tests/example.test.js", environment: "filesystem_namespace" });
      await invoke("commit_changes", { message: "Repair backend" });
      await invoke("report_done", {});
      return "Reported";
    });
    const result = await f.run();
    assert.equal(f.calls.length, 2);
    assert.deepEqual(result.tool_events.map(event => event.tool), ["read_file", "write_diff", "run_check", "commit_changes", "report_done"]);
    assert.ok(result.tool_events.every(event => event.status === "success"));
    assert.equal(f.serviceCalls.find(call => call.name === "run_check").args.environment, "filesystem_namespace");
    assert.ok(f.serviceCalls.every(call => call.context.agent_identity.provider === provider));
    assert.ok(f.saved.some(checkpoint => checkpoint.sdk_turn_progress?.status === "discovery_complete"));
    assert.equal(f.saved.at(-1).status, "completed");
  });
}

test("compatible Coder keeps scope, schema, workflow and completion restrictions", async () => {
  const f = fixture("ollama", async ({ invoke }) => {
    await invoke("read_file", { path: "workflows/agents/coder/README.md" });
    for (const path of ["backend/outside.js", "workflows/agents/coder/README.md", ".forge/private.json"])
      assert.match(await invoke("write_diff", { path, content: "forbidden", before_checksum: null }), /error/i);
    assert.match(await invoke("run_check", { type: "test", command: "node --test backend/a.js", environment: "sudo" }), /error/i);
    await invoke("write_diff", { path: "backend/example.js", content: "fixed", before_checksum: null });
    assert.match(await invoke("report_done", {}), /error/i);
    throw Object.assign(new Error("Restriction checks complete"), { code: "TEST_RESTRICTIONS_COMPLETE" });
  });
  await assert.rejects(f.run(), /Restriction checks complete/);
  assert.equal(f.serviceCalls.filter(call => call.name === "write_diff").length, 1);
  assert.ok(f.serviceCalls.every(call => call.name !== "report_done" && call.name !== "run_check"));
  assert.equal(f.saved.at(-1).status, "blocked");
});

test("compatible Coder Resume retains completed mutations and instruction state", async () => {
  const resume = { status: "failed", provider: "ollama", agent_id: "SIGNED", last_completed_turn: 3,
    completed_tools: ["read_file", "write_diff", "commit_changes"], changed_paths: ["backend/example.js"], coder_rules_read: true };
  const f = fixture("ollama", async ({ invoke, input }) => {
    assert.match(input, /RESUMED RUN/);
    assert.match(input, /write_diff/);
    await invoke("report_done", {});
    return "Resumed report";
  }, resume);
  await f.run();
  assert.deepEqual(f.serviceCalls.map(call => call.name), ["report_done"]);
  assert.deepEqual(f.saved.at(-1).completed_tools, [...resume.completed_tools, "report_done"]);
});

test("compatible Coder prose cannot create completion evidence", async () => {
  const f = fixture("ollama", async () => "Everything passed and committed");
  await assert.rejects(f.run());
  assert.equal(f.serviceCalls.length, 0);
  assert.equal(f.saved.at(-1).status, "blocked");
});

test("Stop aborts compatible Coder before a phase can launch another turn", async () => {
  const controller = new AbortController();
  const stopped = Object.assign(new Error("Owner stopped execution"), { code: "TICKET_STOPPED" });
  const f = fixture("ollama", async ({ invoke }) => {
    await invoke("read_file", { path: "workflows/agents/coder/README.md" });
    controller.abort(stopped);
    return "Discovery complete";
  });
  f.request.abortSignal = controller.signal;
  await assert.rejects(f.run(), { code: "TICKET_STOPPED" });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.serviceCalls.map(call => call.name), ["read_file"]);
  assert.equal(f.saved.at(-1).status, "blocked");
});

test("provider failure retains tool progress without fallback or automatic replay", async () => {
  const f = fixture("ollama", async ({ invoke }) => {
    await invoke("read_file", { path: "workflows/agents/coder/README.md" });
    throw new Error("Provider unavailable after discovery");
  });
  await assert.rejects(f.run(), /Provider unavailable/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.saved.at(-1).provider, "ollama");
  assert.equal(f.saved.at(-1).status, "blocked");
  assert.deepEqual(f.saved.at(-1).completed_tools, ["read_file"]);
});

for (const provider of ["ollama", "openai"]) {
  test(`Supervisor dispatch sends ${provider} the governed ticket instead of a greeting`, async () => {
    const selected = { agent_id: "SIGNED", agent_name: "Coder", role: "coder", provider, enabled: true, status: "ready" };
    const gateway = { execute: async input => {
      assert.equal(input.agent, selected);
      assert.match(input.prompt, /Repair actual backend/);
      assert.deepEqual(input.options.forgeTools.definitions.map(tool => tool.name), CODER_TOOL_NAMES);
      const tools = input.options.forgeTools.registry;
      await tools.write_diff.execute({ path: "backend/example.js", content: "fixed", before_checksum: null });
      await tools.commit_changes.execute({ message: "Repair" });
      await tools.report_done.execute({});
      return { text: "Reported ticket" };
    } };
    const integration = createNodeforgeTaskIntegration({ projectRoot: process.cwd(), projectLogger: () => {},
      agentResolver: { list: () => [selected], resolveAvailable: () => selected }, supervisorManager: { startTask: async () => ({}) },
      eventBus: { publish: async () => {} }, handoffQueue: { enqueue: async () => ({ id: "JOB" }) },
      runtimeGovernance: { createExecutionContext: input => input },
      ...(provider === "ollama" ? { ollamaSdkGateway: gateway } : { openaiSdkGateway: gateway }),
      toolRegistry: Object.fromEntries(["write_diff", "commit_changes", "report_done"].map(name => [name, { execute: async () => ({}) }])) });
    const result = await integration.submitTicket({ ticket: { id: "TASK", title: "Repair actual backend", execution_contract: { coder: "SIGNED" }, execution_policy: { review_gate: "off" } } });
    assert.equal(result.response, "Reported ticket");
    assert.deepEqual(result.tool_events.map(event => event.tool), ["write_diff", "commit_changes", "report_done"]);
  });
}
