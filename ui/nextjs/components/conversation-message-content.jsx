'use client';
// Render conversation messages with inline and fenced code blocks.

import { useState } from "react";

// Renders message content handling code blocks.
export function MessageContent({ text }) {
  const parts = parseCodeBlocks(text);
  return <div className="message-content">{parts.map((part, index) => part.code
    ? <CodeBlock key={`code-${index}`} language={part.language} code={part.code} />
    : <TextWithInline key={`text-${index}`} text={part.text} />)}</div>;
}

// Renders text with inline code segments.
function TextWithInline({ text }) {
  const value = String(text ?? "");
  if (!value) return null;
  const segments = [];
  const pattern = /`([^`]+)`/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(value))) {
    const start = match.index;
    if (start > last) segments.push({ text: value.slice(last, start) });
    segments.push({ inlineCode: match[1] });
    last = start + match[0].length;
  }
  if (last < value.length) segments.push({ text: value.slice(last) });
  if (segments.length === 0) return <p>{value}</p>;
  const hasInline = segments.some((s) => s.inlineCode);
  if (!hasInline) return <p>{value}</p>;
  return <p>{segments.map((seg, i) => seg.inlineCode ? <InlineCode key={i} code={seg.inlineCode} /> : <span key={i}>{seg.text}</span>)}</p>;
}

// Adds a copy action to inline code.
function InlineCode({ code }) {
  const [copied, setCopied] = useState(false);
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
      } catch { /* treat malformed JSON as normal text */ }
    }
  }
  if (cursor < value.length || parts.length === 0) parts.push({ text: value.slice(cursor) });
  return parts;
}
