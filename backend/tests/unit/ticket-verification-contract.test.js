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
