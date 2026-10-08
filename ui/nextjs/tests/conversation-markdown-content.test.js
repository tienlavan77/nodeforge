// Verifies conversation replies retain the plain-text renderer and Markdown export gates stay explicit.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const contentSource = await readFile("ui/nextjs/components/conversation-message-content.jsx", "utf8");
const historySource = await readFile("ui/nextjs/lib/use-conversation-message-history.js", "utf8");
const streamSource = await readFile("ui/nextjs/lib/home-page-event-stream.js", "utf8");
const actionSource = await readFile("ui/nextjs/components/conversation-message-actions.jsx", "utf8");
const composerSource = await readFile("ui/nextjs/components/home-chat-composer.jsx", "utf8");
const homeSource = await readFile("ui/nextjs/app/page.jsx", "utf8");
const systemSource = await readFile("ui/nextjs/app/system/page.jsx", "utf8");

// Keeps presentation literal even when persisted metadata retains a Markdown MIME type.
test("conversation replies use the plain-text renderer without analysis controls", () => {
  assert.doesNotMatch(contentSource, /MarkdownPreviewContent|AnalyzedAgentContent|conversation-content-toggle|Raw|Formatted/);
  assert.doesNotMatch(homeSource, /analyze=\{message\.from === "agent"\}/);
  assert.doesNotMatch(systemSource, /analyze=\{message\.from === "agent"\}/);
  assert.doesNotMatch(composerSource, /Markdown reply/);
});

// Keeps protocol format handling fail-closed while export permissions remain independent of display.
test("format metadata stays fail-closed and export actions remain explicitly gated", () => {
  assert.match(streamSource, /payload\?\.content_type === "text\/markdown" \? "text\/markdown" : "text\/plain"/);
  assert.match(historySource, /declaredType === undefined && content\.markdown_provenance === "owner-markdown-opt-in-v1"/);
  assert.match(actionSource, /message\?\.content_type === "text\/markdown"/);
  assert.match(actionSource, /Download Markdown/);
  assert.match(actionSource, /saveConversationMarkdown/);
});
