// Verifies conversion reports distinguish actual committed work, explicit failures,
// and skipped versions. Historical files lacking purpose comments remain eligible
// for conversion without an automated comment-writing or bulk completion step.
import assert from "node:assert/strict";
import test from "node:test";
import { summaryFixture } from "./purpose-summary-fixture.js";
import { backfillPurposeSummaries } from "../../src/modules/index/purpose-summary-backfill.js";

test("reports distinguish failed attempts and unrun work from committed conversion", async (t) => {
  const f = await summaryFixture(t, "function save() {}");
  f.database.run("DELETE FROM purpose_summary_conversion");
  let attempts = 0;
  const failed = await backfillPurposeSummaries({
    database: f.database,
    indexer: {
      // Exposes a real failed outcome without pretending the converter committed
      // anything; the retry below then exercises the production indexer.
      async handleDetailed({ payload }) {
        attempts++;
        return { path: payload.path, status: "failed", marker: "read_failed", message: "Source unreadable", committed: false };
      }
    }
  });
  assert.equal(attempts, 1);
  assert.equal(failed.succeeded, false);
  assert.deepEqual(failed.results, [{ path: f.path, status: "failed", marker: "read_failed", message: "Source unreadable", committed: false }]);
  assert.equal(f.database.all("SELECT * FROM purpose_summary_conversion").length, 0);
  const passed = await backfillPurposeSummaries({ database: f.database, indexer: f.indexer });
  assert.equal(passed.succeeded, true);
  assert.equal(passed.results[0].committed, true);
  assert.equal(f.symbols()[0].summary, null);
  const skipped = await backfillPurposeSummaries({
    database: f.database,
    indexer: {
      // Any extraction after the receipt would be duplicate work; throwing makes
      // an accidental retry observable instead of manufacturing passing evidence.
      async handleDetailed() { throw new Error("Unexpected duplicate extraction"); }
    }
  });
  assert.equal(skipped.succeeded, true);
  assert.deepEqual(skipped.results, [{ path: f.path, status: "unchanged", committed: false }]);
  assert.equal(f.database.all("SELECT content FROM file_content_fts")[0].content, "function save() {}");
});
