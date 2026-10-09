// Verifies rendered Sprint scope counts do not invent approval or hide missing immutable detail.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SprintTicketScope } from "../components/sprint-ticket-scope.js";

for (const status of ["awaiting_human_approval", "approved", "ready"]) {
  test(`partial ${status} Sprint renders scope, not an inferred approval label`, () => {
    const html = renderToStaticMarkup(createElement(SprintTicketScope, { sprint: { status, ticket_ids: ["TICKET-A", "TICKET-B"], tickets: [{ id: "TICKET-A" }] } }));
    assert.match(html, /Tickets \(1 details \/ 2 in scope\)/);
    assert.match(html, /role="status"/);
    assert.match(html, /1 scope ticket identities are missing immutable detail/);
    assert.doesNotMatch(html, /approved/);
  });
}

for (const [label, sprint, count] of [
  ["full", { ticket_ids: ["TICKET-A"], tickets: [{ id: "TICKET-A" }] }, 1],
  ["empty", { ticket_ids: [], tickets: [] }, 0],
  ["unbound", { tickets: [] }, 0],
  ["legacy", { tickets: [{ id: "TICKET-A" }] }, 1]
]) {
  test(`${label} Sprint renders neutral scope counts without a missing-detail warning`, () => {
    const html = renderToStaticMarkup(createElement(SprintTicketScope, { sprint }));
    assert.ok(html.includes(`Tickets (${count} details / ${count} in scope)`));
    assert.doesNotMatch(html, /approved|role="status"|missing immutable detail/);
  });
}
