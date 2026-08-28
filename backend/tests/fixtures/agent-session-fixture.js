const sender = { id: "AGENT-SESSION-FIXTURE-001", type: "ai", role: "builder" };

write({
  protocol_version: "1.2.0",
  message_id: "MSG-SESSION-START-001",
  sender,
  receiver: { id: "NODE-001", type: "system", role: "orchestrator" },
  timestamp: "2026-08-17T11:00:00Z",
  message: {
    type: "sessions.start",
    request_id: "REQ-SESSION-START-001",
    project_id: "PROJECT-agent-session-test",
    task_id: "TASK-001",
    timestamp: "2026-08-17T11:00:00Z",
    payload: {
      capability_scopes: {
        context: [
          {
            resource: "broker",
            actions: ["request"]
          }
        ]
      }
    }
  }
});

setTimeout(() => {
  write({
    protocol_version: "1.2.0",
    message_id: "MSG-SESSION-STOP-001",
    sender,
    receiver: { id: "NODE-001", type: "system", role: "orchestrator" },
    timestamp: "2026-08-17T11:00:01Z",
    message: {
      type: "sessions.stop",
      request_id: "REQ-SESSION-STOP-001",
      project_id: "PROJECT-agent-session-test",
      timestamp: "2026-08-17T11:00:01Z",
      payload: {}
    }
  });
}, 25);

function write(envelope) {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
