const sender = { id: "AGENT-STREAM-FIXTURE-001", type: "ai", role: "builder" };

setTimeout(() => {
  for (let sequence = 1; sequence <= 5; sequence += 1) {
    process.stdout.write(`${JSON.stringify({
      protocol_version: "1.2.0",
      message_id: `MSG-STREAM-${sequence}`,
      sender,
      receiver: { id: "NODE-001", type: "system", role: "orchestrator" },
      timestamp: "2026-08-17T13:00:00Z",
      message: {
        event_id: `EVT-STREAM-${sequence}`,
        type: "context.pack_generated",
        project_id: "PROJECT-stream-test",
        timestamp: "2026-08-17T13:00:00Z",
        payload: { sequence }
      }
    })}\n`);
  }
  process.stderr.write("fixture stream diagnostic\n");
}, 50);
