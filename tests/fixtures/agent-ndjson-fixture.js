import readline from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

if (process.argv[2] === "--e2e") {
  runEndToEnd(process.argv[3]);
} else if (process.argv[2] === "--builder-auth") {
  runBuilderAuth(process.argv[3]);
} else if (process.argv[2] === "--reviewer-auth") {
  runReviewerAuth();
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

function runBuilderAuth(projectRoot) {
  input.once("line", async (line) => {
    const command = JSON.parse(line);
    const sender = { id: "AGENT-BUILDER-AUTH-001", type: "ai", role: "builder" };
    const receiver = { id: "NODE-001", type: "system", role: "orchestrator" };
    const timestamp = "2026-08-18T10:00:00Z";
    const sourcePath = join(projectRoot, "src", "auth.js");
    const source = "export function login(credentials) {\n  return credentials.token;\n}\n";

    writeEnvelope(sessionStart(command.message.project_id, sender, receiver, timestamp, "BUILDER"));
    writeEnvelope(reportTouch(command.message.project_id, sender, receiver, timestamp, "BUILDER", "src/auth.js"));
    process.stderr.write("builder writing src/auth.js\n");
    await writeFile(sourcePath, source);
    writeEnvelope({
      protocol_version: "1.2.0",
      message_id: "MSG-BUILDER-AUTH-PROGRESS-001",
      sender,
      receiver,
      timestamp,
      message: {
        event_id: "EVT-BUILDER-AUTH-PROGRESS-001",
        type: "context.pack_generated",
        project_id: command.message.project_id,
        timestamp,
        payload: { path: "src/auth.js", phase: "written" }
      }
    });
    writeEnvelope(sessionStop(command.message.project_id, sender, receiver, timestamp, "BUILDER"));
    input.close();
  });
}

function runReviewerAuth() {
  input.once("line", (line) => {
    const command = JSON.parse(line);
    const sender = { id: "AGENT-REVIEWER-AUTH-001", type: "ai", role: "reviewer" };
    const receiver = { id: "NODE-001", type: "system", role: "orchestrator" };
    const timestamp = "2026-08-18T10:01:00Z";
    writeEnvelope(sessionStart(command.message.project_id, sender, receiver, timestamp, "REVIEWER"));
    writeEnvelope({
      protocol_version: "1.2.0",
      message_id: "MSG-REVIEWER-CONTEXT-READ-001",
      sender,
      receiver,
      timestamp,
      message: {
        type: "context.read_file",
        request_id: "REQ-REVIEWER-CONTEXT-READ-001",
        project_id: command.message.project_id,
        timestamp,
        payload: { path: "src/auth.js" }
      }
    });
    input.once("line", (responseLine) => {
      const response = JSON.parse(responseLine);
      if (response.message?.type !== "context.pack_generated") return;
      writeEnvelope({
        protocol_version: "1.2.0",
        message_id: "MSG-REVIEWER-VERDICT-001",
        sender,
        receiver,
        timestamp,
        message: {
          event_id: "EVT-REVIEWER-VERDICT-001",
          type: "review.requested",
          project_id: command.message.project_id,
          timestamp,
          payload: {
            result: "changes_required",
            findings: [{ path: response.message.payload.path, line: 2, severity: "warning", message: "Authentication result lacks error handling." }]
          }
        }
      });
      writeEnvelope(sessionStop(command.message.project_id, sender, receiver, timestamp, "REVIEWER"));
      // Flush both protocol messages before ending the fixture process.
      process.stdout.write("", () => {
        input.close();
        process.exit(0);
      });
    });
  });
}

function sessionStart(projectId, sender, receiver, timestamp, label) {
  return {
    protocol_version: "1.2.0",
    message_id: `MSG-${label}-SESSION-START-001`,
    sender,
    receiver,
    timestamp,
    message: {
      type: "sessions.start",
      request_id: `REQ-${label}-SESSION-START-001`,
      project_id: projectId,
      timestamp,
      payload: { capability_scopes: { context: [{ resource: "broker", actions: ["request"] }] } }
    }
  };
}

function sessionStop(projectId, sender, receiver, timestamp, label) {
  return {
    protocol_version: "1.2.0",
    message_id: `MSG-${label}-SESSION-STOP-001`,
    sender,
    receiver,
    timestamp,
    message: { type: "sessions.stop", request_id: `REQ-${label}-SESSION-STOP-001`, project_id: projectId, timestamp, payload: {} }
  };
}

function reportTouch(projectId, sender, receiver, timestamp, label, path) {
  return {
    protocol_version: "1.2.0",
    message_id: `MSG-${label}-REPORT-TOUCH-001`,
    sender,
    receiver,
    timestamp,
    message: { type: "agents.report_touch", request_id: `REQ-${label}-REPORT-TOUCH-001`, project_id: projectId, timestamp, payload: { path } }
  };
}

function writeEnvelope(envelope) {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
