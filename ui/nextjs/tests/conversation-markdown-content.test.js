// Verifies conversation Markdown is rendered only from protocol content types and unsafe links stay inert.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const contentSource = await readFile("ui/nextjs/components/conversation-message-content.jsx", "utf8");
const previewSource = await readFile("ui/nextjs/components/markdown-preview-content.jsx", "utf8");
const historySource = await readFile("ui/nextjs/lib/use-conversation-message-history.js", "utf8");
const streamSource = await readFile("ui/nextjs/lib/home-page-event-stream.js", "utf8");

test("conversation renderer selects Markdown only for its declared content type", () => {
  assert.match(contentSource, /contentType === "text\/markdown"/);
  assert.match(contentSource, /<MarkdownPreviewContent markdown=\{text\}/);
  assert.match(historySource, /"text\/markdown"/);
  assert.match(streamSource, /content_type: payload\.content_type/);
});

test("Markdown renderer escapes HTML and permits only safe link protocols", () => {
  assert.doesNotMatch(previewSource, /dangerouslySetInnerHTML/);
  assert.match(previewSource, /\^\(https\?:\|mailto:\)/);
  assert.match(previewSource, /target="_blank" rel="noreferrer noopener"/);
  assert.match(previewSource, /<strong/);
  assert.match(previewSource, /<em/);
});
