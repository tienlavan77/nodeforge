import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAgentProcess, createEnvelopeValidator } from "../../src/modules/agents/agent-process.js";

const fixture = fileURLToPath(new URL("../fixtures/agent-ndjson-fixture.js", import.meta.url));

test("sends a schema-valid NDJSON Command to an agent and receives a buffered Event response", async () => {
  const validateEnvelope = createEnvelopeValidator();
  const agent = createAgentProcess({ command: process.execPath, args: [fixture] });
  const command = commandEnvelope();
  const stderr = [];
  agent.on("stderr", (chunk) => stderr.push(chunk));

  try {
    const messagePromise = once(agent, "message").then(([envelope]) => envelope);
    await agent.send(command);
    const event = await messagePromise;

    assert.equal(validateEnvelope(command), true);
    assert.equal(validateEnvelope(event), true);
    assert.equal(event.message.type, "context.pack_generated");
    assert.equal(event.message.payload.received_request_id, command.message.request_id);
    assert.equal(stderr.join(""), "fixture diagnostic\n");
    await once(agent.child, "exit");
  } finally {
    agent.close();
    if (!agent.child.killed && agent.child.exitCode === null) agent.child.kill();
  }
});

test("sends a schema-valid NDJSON Event response from Node to an agent", async () => {
  const validateEnvelope = createEnvelopeValidator();
  const agent = createAgentProcess({ command: process.execPath, args: [fixture] });
  const event = contextPackEnvelope();

  try {
    const messagePromise = once(agent, "message").then(([envelope]) => envelope);
    const childExit = once(agent.child, "exit");
    await agent.sendEvent(event);
    const response = await messagePromise;

    assert.equal(validateEnvelope(event), true);
    assert.equal(validateEnvelope(response), true);
    assert.equal(response.message.type, "context.pack_generated");
    await childExit;
  } finally {
    agent.close();
    if (!agent.child.killed && agent.child.exitCode === null) agent.child.kill();
  }
});

function commandEnvelope() {
  return {
    protocol_version: "1.2.0",
    message_id: "MSG-NODE-COMMAND-001",
    sender: { id: "NODE-001", type: "system", role: "orchestrator" },
    receiver: { id: "AGENT-FIXTURE-001", type: "ai", role: "builder" },
    timestamp: "2026-08-17T10:00:00Z",
    message: {
      type: "context.request",
      request_id: "REQ-AGENT-001",
      project_id: "PROJECT-001",
      session_id: "SESSION-001",
      timestamp: "2026-08-17T10:00:00Z",
      payload: { query: "Explain the current task." }
    }
  };
}

function contextPackEnvelope() {
  return {
    protocol_version: "1.2.0",
    message_id: "MSG-NODE-CONTEXT-PACK-001",
    sender: { id: "NODE-001", type: "system", role: "context-engine" },
    receiver: { id: "AGENT-FIXTURE-001", type: "ai", role: "builder" },
    timestamp: "2026-08-18T09:00:00Z",
    message: {
      event_id: "EVT-NODE-CONTEXT-PACK-001",
      type: "context.pack_generated",
      project_id: "PROJECT-001",
      request_id: "REQ-CONTEXT-READ-001",
      timestamp: "2026-08-18T09:00:00Z",
      payload: { path: "src/auth.js", content: "export function login() {}\n", symbols: [] }
    }
  };
}
