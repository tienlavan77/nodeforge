// Verifies that Sprint Leader ticket checks cover every acceptance criterion before Coder dispatch.
import assert from "node:assert/strict";
import test from "node:test";
import { assertTicketVerificationContract } from "../../src/modules/governance/ticket-verification-contract.js";

// Accepts executable and browser checks when their criterion IDs cover the ticket.
test("verification contract maps every criterion to a typed check", () => {
  const ticket = {
    acceptance_criteria: ["Navigation works", "Layout has no overflow"],
    verification_plan: [
      { criterion_ids: ["AC-1"], kind: "test", test_path: "ui/nextjs/tests/navigation.test.js" },
      { criterion_ids: ["AC-2"], kind: "browser", viewports: [375, 1440], assertions: ["document width has no overflow"] }
    ]
  };
  assert.equal(assertTicketVerificationContract(ticket), true);
});

// Rejects a Sprint Leader proposal when it leaves a criterion to inference.
test("verification contract rejects an uncovered criterion", () => {
  assert.throws(() => assertTicketVerificationContract({
    acceptance_criteria: ["Navigation works", "Layout has no overflow"],
    verification_plan: [{ criterion_ids: ["AC-1"], kind: "test", test_path: "ui/nextjs/tests/navigation.test.js" }]
  }), { code: "TICKET_VERIFICATION_PLAN_INVALID" });
});

// Uses the canonical schema to reject browser plans that would otherwise fail later during Sprint ingestion.
test("browser verification rejects non-integer, non-positive, duplicate or missing viewport widths", () => {
  for (const viewports of [["375"], [{ width: 375, height: 812 }], ["375x812"], ["mobile"], [375.5], [0], [-1], [375, 375], [null], [], undefined]) {
    assert.throws(() => assertTicketVerificationContract({ acceptance_criteria: ["No overflow"], verification_plan: [{ kind: "browser", criterion_ids: ["AC-1"], assertions: ["No horizontal overflow"], viewports }] }), (error) => error.code === "TICKET_VERIFICATION_PLAN_INVALID" && error.message.includes("viewports"));
  }
});

// Rejects the rest of the step schema at the same early gate, without coercion or dropping unknown fields.
test("verification contract checks all step fields against the canonical ticket schema", () => {
  const valid = { kind: "browser", criterion_ids: ["AC-1"], assertions: ["No overflow"], viewports: [375, 1440] };
  for (const patch of [{ assertions: [123] }, { assertions: [""] }, { notes: {} }, { criterion_ids: ["AC-1", "AC-1"] }, { unexpected: "field" }]) {
    assert.throws(() => assertTicketVerificationContract({ acceptance_criteria: ["No overflow"], verification_plan: [{ ...valid, ...patch }] }), { code: "TICKET_VERIFICATION_PLAN_INVALID" });
  }
  const ticket = { acceptance_criteria: ["No overflow"], verification_plan: [valid] };
  const original = structuredClone(ticket);
  assert.equal(assertTicketVerificationContract(ticket), true);
  assert.deepEqual(ticket, original);
});
