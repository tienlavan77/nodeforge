// Verifies that separating the appended sandbox design preserves both the
// original lifecycle baseline and every byte of the observed combined document.
// Independent hashes and full reconstruction prevent documentation cleanup from
// discarding the separate isolation design or silently replacing its history.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("separated lifecycle amendment reconstructs the observed document without changing its original baseline", async () => {
  const root = new URL("../../../", import.meta.url);
  const lineage = JSON.parse(await readFile(new URL("../fixtures/repository-document-amendment-inventory.json", import.meta.url), "utf8"));
  const inventory = JSON.parse(await readFile(new URL("../fixtures/repository-document-inventory.json", import.meta.url), "utf8"));
  const entry = inventory.documents.find((item) => item.target === lineage.original_path);
  assert.equal(entry.sha256, lineage.original_sha256);
  const original = await readFile(new URL(lineage.original_path, root), "utf8");
  const section = await readFile(new URL(lineage.section_path, root), "utf8");
  assert.match(section, /^<!--.*-->\n/);
  assert.equal("sha256:" + createHash("sha256").update(original).digest("hex"), entry.sha256);
  assert.equal("sha256:" + createHash("sha256").update(section).digest("hex"), lineage.section_sha256);
  const body = section.split("\n").slice(lineage.section_header_lines).join("\n");
  assert.equal("sha256:" + createHash("sha256").update(original + lineage.separator + body).digest("hex"),
    lineage.combined_before_sha256, "Both topics must reconstruct the complete document observed before separation.");
});
