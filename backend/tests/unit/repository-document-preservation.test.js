// Verifies byte preservation when repository design documents move and the original architecture discussion is split into bounded references, so documentation cleanup cannot silently discard historical requirements or design context.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const inventory = JSON.parse(await readFile(new URL("../fixtures/repository-document-inventory.json", import.meta.url), "utf8"));

// Computes the source digest used by the retained pre-mutation inventory to detect accidental content changes during documentation relocation.
function digest(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

test("historical documentation archival preserves the protected runtime guidance baseline", async () => {
  const guidance = JSON.parse(await readFile(new URL("../fixtures/repository-guidance-inventory.json", import.meta.url), "utf8"));
  for (const entry of guidance.files) assert.equal(digest(await readFile(new URL(entry.path, root))), entry.sha256, entry.path);
});

// Checks the four relocated PNG assets against hashes captured from the live
// service before moving them, ensuring archive cleanup preserves original bytes
// and leaves navigable documentation links without duplicate source locations.
test("relocated PNG assets retain original bytes and documented destinations", async () => {
  const assets = JSON.parse(await readFile(new URL("../fixtures/repository-assets-inventory.json", import.meta.url), "utf8"));
  const overview = await readFile(new URL("docs/README.md", root), "utf8");
  for (const entry of assets.documents) {
    const bytes = await readFile(new URL(entry.target, root));
    assert.equal(digest(bytes), entry.sha256, entry.target);
    assert.equal(bytes.length, entry.size_bytes, entry.target);
    assert.ok(overview.includes(entry.target.replace(/^docs\//, "")), entry.target);
    await assert.rejects(access(new URL(entry.source, root)), { code: "ENOENT" });
  }
});

test("relocated design documents retain every original byte and remove old locations", async () => {
  for (const entry of inventory.documents) {
    const bytes = await readFile(new URL(entry.target, root));
    assert.equal(digest(bytes), entry.sha256, entry.target);
    await assert.rejects(access(new URL(entry.source, root)), { code: "ENOENT" });
  }
});

test("architecture reference parts reconstruct the complete original discussion", async () => {
  const parts = [];
  for (const [index, entry] of inventory.architecture.parts.entries()) {
    let content = await readFile(new URL(entry.path, root), "utf8");
    assert.match(content, /^<!--.*-->\n/);
    content = content.slice(content.indexOf("\n") + 1);
    if (index === 1) content = content.replace(/^(login|refreshSession|logout)\(\)$/gm, "function $1()");
    assert.ok(content.split("\n").filter((line) => line.trim()).length <= 250, entry.path);
    parts.push(content);
  }
  assert.equal(digest(parts.join("")), inventory.architecture.sha256);
});

test("archived workflow documents retain bytes from the pre-move inventory", async () => {
  const workflows = JSON.parse(await readFile(new URL("../fixtures/repository-workflow-inventory.json", import.meta.url), "utf8"));
  const archive = JSON.parse(await readFile(new URL("../fixtures/repository-workflow-archive-inventory.json", import.meta.url), "utf8"));
  const historical = JSON.parse(await readFile(new URL("../fixtures/repository-historical-docs-inventory.json", import.meta.url), "utf8"));
  for (const entry of [...workflows.documents, ...archive.documents, ...historical.documents]) {
    let content;
    if (entry.parts) {
      const parts = [];
      const overview = await readFile(new URL(entry.target, root), "utf8");
      for (const path of entry.parts) {
        const part = await readFile(new URL(path, root), "utf8");
        assert.match(part, /^<!--.*-->\n/);
        assert.ok(part.split("\n").filter((line) => line.trim()).length <= 250, path);
        assert.ok(overview.includes(path.split("/").pop()) || overview.includes(encodeURI(path.split("/").pop())), entry.target);
        let body = part.slice(part.indexOf("\n") + 1);
        if (entry.part_encoding === "markdown_blockquote") {
          assert.ok(body.split("\n").every((line) => line.startsWith("> ")), path);
          body = body.replace(/^> /gm, "");
        }
        parts.push(body);
      }
      content = parts.join("");
    } else content = await readFile(new URL(entry.target, root), "utf8");
    for (const rewrite of entry.content_rewrites ?? []) {
      assert.ok(content.includes(rewrite.after), entry.target);
      content = content.replaceAll(rewrite.after, rewrite.before);
    }
    for (const rewrite of entry.link_rewrites ?? []) {
      assert.ok(content.includes(rewrite.after), entry.target);
      if (rewrite.after.endsWith(")")) await access(new URL(rewrite.after.slice(2, -1), new URL(entry.target, root)));
      else for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
        if (match[1].startsWith(rewrite.after.slice(2))) await access(new URL(match[1], new URL(entry.target, root)));
      }
      content = content.replaceAll(rewrite.after, rewrite.before);
    }
    assert.equal(digest(content), entry.sha256, entry.target);
    await assert.rejects(access(new URL(entry.source, root)), { code: "ENOENT" });
  }
});
