// Verifies conversation Markdown rendering is restored without weakening plain-text or export boundaries.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

const contentSource = await readFile("ui/nextjs/components/conversation-message-content.jsx", "utf8");
const historySource = await readFile("ui/nextjs/lib/use-conversation-message-history.js", "utf8");
const streamSource = await readFile("ui/nextjs/lib/home-page-event-stream.js", "utf8");
const actionSource = await readFile("ui/nextjs/components/conversation-message-actions.jsx", "utf8");
const composerSource = await readFile("ui/nextjs/components/home-chat-composer.jsx", "utf8");
const homeSource = await readFile("ui/nextjs/components/architecture-workspace.jsx", "utf8");
const systemSource = await readFile("ui/nextjs/app/system/page.jsx", "utf8");

// Restores formatted Markdown only when the protocol explicitly declares it.
test("conversation replies select Markdown by content type without analysis controls", () => {
  assert.match(contentSource, /contentType = "text\/plain"/);
  assert.match(contentSource, /contentType === "text\/markdown"/);
  assert.match(contentSource, /<MarkdownPreviewContent markdown=\{text\} variant="conversation"/);
  assert.doesNotMatch(contentSource, /AnalyzedAgentContent|conversation-content-toggle|Raw|Formatted/);
  assert.doesNotMatch(homeSource, /analyze=\{message\.from === "agent"\}/);
  assert.doesNotMatch(systemSource, /analyze=\{message\.from === "agent"\}/);
  assert.match(composerSource, /\[markdownReply, setMarkdownReply\] = useState\(false\)/);
  assert.match(composerSource, /markdownReply \? "text\/markdown" : "text\/plain"/);
  assert.match(composerSource, /Markdown reply/);
});

// Keeps protocol format handling fail-closed while export permissions remain independent of display.
test("format metadata stays fail-closed and export actions remain explicitly gated", () => {
  assert.match(streamSource, /payload\?\.content_type === "text\/markdown" \? "text\/markdown" : "text\/plain"/);
  assert.match(historySource, /declaredType === undefined && content\.markdown_provenance === "owner-markdown-opt-in-v1"/);
  assert.match(actionSource, /message\?\.content_type === "text\/markdown"/);
  assert.match(actionSource, /Download Markdown/);
  assert.match(actionSource, /saveConversationMarkdown/);
});

// Formats existing and streamed agent text without rewriting persisted MIME types or export eligibility.
test("Architecture and System Engineer display agent replies as Markdown independently of protocol metadata", () => {
  for (const source of [homeSource, systemSource]) {
    assert.match(source, /contentType=\{message\.from === "agent" \? "text\/markdown" : "text\/plain"\}/);
    assert.match(source, /<ConversationAgentMessageActions message=\{message\}/);
  }
});

const compiled = await build({ entryPoints: ["ui/nextjs/components/conversation-message-content.jsx"], bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/*"] });
const componentModule = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(new URL("../package.json", import.meta.url)), componentModule, componentModule.exports);
const { MessageContent } = componentModule.exports;

// Exercises the actual JSX renderer rather than merely checking the Markdown import.
test("Markdown renders headings, tables, lists and code inside conversation-sized content", () => {
  const text = "# Plan\n\n**Approved**\n\n- Item\n\n| Scope | Status |\n| --- | --- |\n| UI | Done |\n\n```js\nconst ready = true;\n```";
  const html = renderToStaticMarkup(createElement(MessageContent, { text, contentType: "text/markdown" }));
  for (const expected of ["markdown-preview-content--conversation", "<h1>", "<strong>", "<ul>", "<table>", "<pre>"]) assert.ok(html.includes(expected), expected);
});

// Leaves ordinary messages literal while retaining clickable project Markdown file references.
test("plain and unspecified messages keep text formatting and Markdown file links", () => {
  for (const contentType of [undefined, "text/plain", "text/html"]) {
    const html = renderToStaticMarkup(createElement(MessageContent, { text: "# Literal\n\n**Not formatted**\n\nworkflows/plan.md", contentType }));
    assert.match(html, /# Literal/);
    assert.match(html, /\*\*Not formatted\*\*/);
    assert.match(html, /conversation-markdown-link/);
    assert.doesNotMatch(html, /<h1>|<strong>|markdown-preview-content/);
  }
});

// Prevents project or agent Markdown from injecting HTML or executable links into chat.
test("formatted Markdown escapes HTML and rejects unsafe links", () => {
  const html = renderToStaticMarkup(createElement(MessageContent, { contentType: "text/markdown", text: '<script>alert(1)</script>\n\n[bad](javascript:alert) [safe](https://example.com)' }));
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|href="javascript:/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /rel="noreferrer noopener"/);
});

// Keeps local file preview available in formatted responses, including code spans and Markdown link labels.
test("formatted replies preserve project Markdown file actions without converting external or traversal links", () => {
  const html = renderToStaticMarkup(createElement(MessageContent, { contentType: "text/markdown", onMarkdownOpen: () => {}, text: 'workflows/plan.md\n\n`docs/review.md`\n\n[Plan](workflows/plan.md)\n\n[External](https://example.com/doc.md)\n\n[Forbidden](../secret.md)\n\nhttps://example.com/doc.md' }));
  assert.equal((html.match(/class="conversation-markdown-link/g) ?? []).length, 3);
  assert.match(html, /href="https:\/\/example.com\/doc.md"/);
  assert.doesNotMatch(html, /href="\.\.\/secret.md"/);
});
