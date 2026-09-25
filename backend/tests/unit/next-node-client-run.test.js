import assert from "node:assert/strict";
import test from "node:test";
import { createNodeClient } from "../../../ui/nextjs/lib/node-client.js";

test("Next TicketCard Run uses the Stage-1 ticket endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, init) => {
    call = { url, init };
    return new Response(JSON.stringify({ ticket_id: "FORGE-1", status: "accepted", pipeline: "stage1" }), {
      status: 202, headers: { "content-type": "application/json" }
    });
  };
  try {
    const result = await createNodeClient().runTicket("PROJECT-NODEFORGE", "FORGE-1");
    assert.deepEqual(result, { ticket_id: "FORGE-1", status: "accepted", pipeline: "stage1" });
    assert.equal(call.url, "http://127.0.0.1:3100/forge/v1/tickets/FORGE-1:run?project=PROJECT-NODEFORGE");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.body, JSON.stringify({ project_id: "PROJECT-NODEFORGE" }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
