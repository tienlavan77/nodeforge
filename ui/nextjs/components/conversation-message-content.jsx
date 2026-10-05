'use client';
// Render conversation messages with inline and fenced code blocks.

import { useState } from "react";

// Renders message content handling code blocks.
export function MessageContent({ text, onMarkdownOpen }) {
  const parts = parseCodeBlocks(text);
  return <div className="message-content">{parts.map((part, index) => part.code
    ? <CodeBlock key={`code-${index}`} language={part.language} code={part.code} />
    : <TextWithInline key={`text-${index}`} text={part.text} onMarkdownOpen={onMarkdownOpen} />)}</div>;
}

// Renders text with inline code segments.
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
function TextWithInline({ text, onMarkdownOpen }) {
  const value = String(text ?? "");
  if (!value) return null;
  const paragraphs = value.split(/\n\s*\n/).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs.map((paragraph, index) => <InlineParagraph key={index} text={paragraph} onMarkdownOpen={onMarkdownOpen} />);
  return <InlineParagraph text={value} onMarkdownOpen={onMarkdownOpen} />;
}

// Renders one response paragraph while preserving intentional line breaks and inline formatting.
function InlineParagraph({ text, onMarkdownOpen }) {
  const segments = [];
  const pattern = /`([^`]+)`/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    const start = match.index;
    if (start > last) segments.push({ text: text.slice(last, start) });
    segments.push({ inlineCode: match[1] });
    last = start + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  if (segments.length === 0) return <p>{text.split("\n").map((line, index) => <span key={index}>{index > 0 && <br />}{line}</span>)}</p>;
  const hasInline = segments.some((s) => s.inlineCode);
  if (!hasInline) return <p>{text.split("\n").map((line, index) => <span key={index}>{index > 0 && <br />}<MarkdownLinks text={line} onOpen={onMarkdownOpen} /></span>)}</p>;
  return <p>{segments.map((seg, i) => seg.inlineCode ? <InlineCode key={i} code={seg.inlineCode} onMarkdownOpen={onMarkdownOpen} /> : <MarkdownLinks key={i} text={seg.text} onOpen={onMarkdownOpen} />)}</p>;
}

// Turns project Markdown references in agent prose into a local preview action.
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
function MarkdownLinks({ text, onOpen }) {
  const parts = String(text ?? "").split(/((?:[\w.-]+\/)*[\w.-]+\.md)\b/g);
  return parts.map((part, index) => part.endsWith(".md") ? <button type="button" className="conversation-markdown-link" key={index} onClick={() => onOpen?.(part)}>{part}</button> : <span key={index}>{part}</span>);
}

// Adds a copy action to inline code.
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
function InlineCode({ code, onMarkdownOpen }) {
  const [copied, setCopied] = useState(false);
  const markdownPath = String(code).trim();
  if (markdownPath.endsWith(".md")) return <button type="button" className="conversation-markdown-link conversation-markdown-code" onClick={() => onMarkdownOpen?.(markdownPath)}>{markdownPath}</button>;
  // Copies code to the clipboard and shows brief confirmation.
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
      else { const t = document.createElement("textarea"); t.value = code; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (error) {
      console.error("Unable to copy inline code", error);
      setCopied(false);
    }
  }
  return <span className="inline-code-wrap"><code className="inline-code">{code}</code><button type="button" className="inline-copy" onClick={copy} aria-label="Copy command">{copied ? "Copied" : "Copy"}</button></span>;
}

// Renders fenced code with a language label and copy action.
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
function CodeBlock({ language, code }) {
  const [copied, setCopied] = useState(false);
  // Copies the code block and shows brief confirmation.
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
      else { const t = document.createElement("textarea"); t.value = code; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (error) {
      console.error("Unable to copy code block", error);
      setCopied(false);
    }
  }
  return <div className="code-block"><div className="code-block-header"><span>{language || "code"}</span><button type="button" className={copied ? "is-copied" : ""} onClick={copy}>{copied ? "Copied" : "Copy"}</button></div><pre><code>{code}</code></pre></div>;
}

// Splits message text into prose and code segments.
function parseCodeBlocks(text) {
  const value = String(text ?? "");
  const parts = [];
  const pattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ text: value.slice(cursor, start) });
    parts.push({ code: match[2].replace(/\n$/, ""), language: match[1].trim() });
    cursor = start + match[0].length;
  }
  if (parts.length === 0) {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        parts.push({ code: JSON.stringify(JSON.parse(trimmed), null, 2), language: "json" });
        return parts;
      // eslint-disable-next-line no-silent-catch -- Malformed text stays ordinary prose.
      } catch { /* treat malformed JSON as normal text */ }
    }
  }
  if (cursor < value.length || parts.length === 0) parts.push({ text: value.slice(cursor) });
  return parts;
}
