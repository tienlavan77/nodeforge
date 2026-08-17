import readline from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [agentId, projectId, projectRoot] = process.argv.slice(2);
const sender = { id: agentId, type: "ai", role: "builder" };
const receiver = { id: "NODE-001", type: "system", role: "orchestrator" };
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on("line", async (line) => {
  const command = JSON.parse(line);
  const { action, path, content } = command.message.payload ?? {};
  if (action === "start") {
    emitSessionStart();
    return;
  }
  if (action === "write") {
    writeEnvelope({
      protocol_version: "1.2.0",
      message_id: `MSG-${agentId}-TOUCH-${command.message.request_id}`,
      sender,
      receiver,
      timestamp: "2026-08-17T18:10:00Z",
      message: {
        type: "agents.report_touch",
        request_id: `REQ-${agentId}-TOUCH-${command.message.request_id}`,
        project_id: projectId,
        timestamp: "2026-08-17T18:10:00Z",
        payload: { path }
      }
    });
    const absolutePath = resolve(projectRoot, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
    writeEnvelope({
      protocol_version: "1.2.0",
      message_id: `MSG-${agentId}-WRITE-${command.message.request_id}`,
      sender,
      receiver,
      timestamp: "2026-08-17T18:10:00Z",
      message: {
        event_id: `EVT-${agentId}-WRITE-${command.message.request_id}`,
        type: "context.pack_generated",
        project_id: projectId,
        timestamp: "2026-08-17T18:10:00Z",
        payload: { action: "write_completed", path }
      }
    });
    return;
  }
  if (action === "stop") {
    writeEnvelope({
      protocol_version: "1.2.0",
      message_id: `MSG-${agentId}-SESSION-STOP`,
      sender,
      receiver,
      timestamp: "2026-08-17T18:10:01Z",
      message: {
        type: "sessions.stop",
        request_id: `REQ-${agentId}-SESSION-STOP`,
        project_id: projectId,
        timestamp: "2026-08-17T18:10:01Z",
        payload: {}
      }
    });
    input.close();
  }
});

function emitSessionStart() {
  writeEnvelope({
    protocol_version: "1.2.0",
    message_id: `MSG-${agentId}-SESSION-START`,
    sender,
    receiver,
    timestamp: "2026-08-17T18:10:00Z",
    message: {
      type: "sessions.start",
      request_id: `REQ-${agentId}-SESSION-START`,
      project_id: projectId,
      timestamp: "2026-08-17T18:10:00Z",
      payload: { capability_scopes: { context: [{ resource: "broker", actions: ["request"] }] } }
    }
  });
}

function writeEnvelope(envelope) {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
