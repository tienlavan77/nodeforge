const sender = { id: "AGENT-IDEMPOTENCY-FIXTURE-001", type: "ai", role: "tester" };

for (const [messageId, requestId] of [
  ["MSG-TEST-ONE-001", "REQ-TEST-ONE"],
  ["MSG-TEST-ONE-002", "REQ-TEST-ONE"],
  ["MSG-TEST-TWO-001", "REQ-TEST-TWO"]
]) {
  process.stdout.write(`${JSON.stringify(envelope(messageId, requestId))}\n`);
}

function envelope(messageId, requestId) {
  return {
    protocol_version: "1.2.0",
    message_id: messageId,
    sender,
    receiver: { id: "NODE-001", type: "system", role: "orchestrator" },
    timestamp: "2026-08-17T12:00:00Z",
    message: {
      type: "verification.run_test",
      request_id: requestId,
      project_id: "PROJECT-idempotency-test",
      session_id: "SESSION-idempotency-test",
      timestamp: "2026-08-17T12:00:00Z",
      payload: { command: "npm test" }
    }
  };
}
