// Confirms ticket Stop reaches the active dispatch with a matching project.
import assert from "node:assert/strict";
import test from "node:test";
import { createForgeV1Router } from "../../src/transport/http/forge-v1-router.js";

// Rejects missing project identity and forwards only the addressed ticket.
test("ticket Stop requires a project and reaches the active dispatch", async () => {
  const received = [];
  const dispatchTicket = async () => ({});
  dispatchTicket.stop = (input) => { received.push(input); return { ticket_id: input.ticketId, status: "stopping" }; };
  const router = createForgeV1Router({ dispatchTicket });
  const route = (url, body) => router.route("POST", new URL(url, "http://localhost"), { headers: {}, async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body); } });
  assert.deepEqual(await route("/forge/v1/tickets/TICKET-1:stop?project=PROJECT-1", { project_id: "PROJECT-1" }), { status: 202, body: { ticket_id: "TICKET-1", status: "stopping" } });
  assert.deepEqual(received, [{ projectId: "PROJECT-1", ticketId: "TICKET-1" }]);
  await assert.rejects(route("/forge/v1/tickets/TICKET-1:stop"), /project/i);
});
