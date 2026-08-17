import readline from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

if (process.argv[2] === "--e2e") {
  runEndToEnd(process.argv[3]);
} else {
  runEcho();
}

function runEcho() {
  input.once("line", (line) => {
  const command = JSON.parse(line);
  process.stderr.write("fixture diagnostic\n");
  const event = {
    protocol_version: "1.2.0",
    message_id: "MSG-AGENT-EVENT-001",
    sender: { id: "AGENT-FIXTURE-001", type: "ai", role: "builder" },
    receiver: { id: "NODE-001", type: "system", role: "orchestrator" },
    timestamp: "2026-08-17T10:00:01Z",
    message: {
      event_id: "EVT-AGENT-001",
      type: "context.pack_generated",
      project_id: command.message.project_id,
      session_id: command.message.session_id,
      timestamp: "2026-08-17T10:00:01Z",
      payload: { received_request_id: command.message.request_id }
    }
  };
  const output = `${JSON.stringify(event)}\n`;
  const midpoint = Math.floor(output.length / 2);
  process.stdout.write(output.slice(0, midpoint));
  setTimeout(() => {
    process.stdout.write(output.slice(midpoint));
    input.close();
  }, 5);
  });
}

function runEndToEnd(projectRoot) {
  input.once("line", async (line) => {
    const command = JSON.parse(line);
    const sender = { id: "AGENT-FIXTURE-001", type: "ai", role: "builder" };
    const receiver = { id: "NODE-001", type: "system", role: "orchestrator" };
    const timestamp = "2026-08-17T16:00:00Z";
    const sourcePath = join(projectRoot, "src", "agent-e2e.js");
    const completeSource = "export function agentCompletedWork() {\n  return 'complete';\n}\n";

    writeEnvelope({
      protocol_version: "1.2.0",
      message_id: "MSG-E2E-SESSION-START-001",
      sender,
      receiver,
      timestamp,
      message: {
        type: "sessions.start",
        request_id: "REQ-E2E-SESSION-START-001",
        project_id: command.message.project_id,
        timestamp,
        payload: {
          capability_scopes: {
            context: [{ resource: "broker", actions: ["request"] }]
          }
        }
      }
    });
    writeEnvelope({
      protocol_version: "1.2.0",
      message_id: "MSG-E2E-REPORT-TOUCH-001",
      sender,
      receiver,
      timestamp,
      message: {
        type: "agents.report_touch",
        request_id: "REQ-E2E-REPORT-TOUCH-001",
        project_id: command.message.project_id,
        timestamp,
        payload: { path: "src/agent-e2e.js" }
      }
    });
    process.stderr.write("agent e2e writing file in two phases\n");
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "export function agentCompletedWork() {\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(sourcePath, completeSource);

    writeEnvelope({
      protocol_version: "1.2.0",
      message_id: "MSG-E2E-PROGRESS-001",
      sender,
      receiver,
      timestamp,
      message: {
        event_id: "EVT-E2E-PROGRESS-001",
        type: "context.pack_generated",
        project_id: command.message.project_id,
        timestamp,
        payload: { path: "src/agent-e2e.js", phase: "complete" }
      }
    });
    writeEnvelope({
      protocol_version: "1.2.0",
      message_id: "MSG-E2E-SESSION-STOP-001",
      sender,
      receiver,
      timestamp,
      message: {
        type: "sessions.stop",
        request_id: "REQ-E2E-SESSION-STOP-001",
        project_id: command.message.project_id,
        timestamp,
        payload: {}
      }
    });
    input.close();
  });
}

function writeEnvelope(envelope) {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
