"use client";
// Renders a safe, readable Markdown document in the project-file preview panel.

// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
function InlineMarkdown({ text, onMarkdownOpen }) {
  const parts = String(text ?? "").split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^\s)]+\))/g);
  return parts.map((part, index) => {
    const link = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(part);
    if (link) {
      if (onMarkdownOpen && projectMarkdownPath(link[2])) return <button key={index} type="button" className="conversation-markdown-link" onClick={() => onMarkdownOpen(link[2])}>{link[1]}</button>;
      const href = safeLinkHref(link[2]);
      return href ? <a key={index} href={href} target="_blank" rel="noreferrer noopener">{link[1]}</a> : <span key={index}>{link[1]}</span>;
    }
    if (part.startsWith("`")) {
      const code = part.slice(1, -1);
      return onMarkdownOpen && projectMarkdownPath(code) ? <button key={index} type="button" className="conversation-markdown-link conversation-markdown-code" onClick={() => onMarkdownOpen(code)}>{code}</button> : <code key={index}>{code}</code>;
    }
    if (part.startsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
    return <span key={index}>{onMarkdownOpen ? part.split(/((?<![\w/.:-])(?:[\w.-]+\/)*[\w.-]+\.md)\b/g).map((value, valueIndex) => projectMarkdownPath(value) ? <button key={valueIndex} type="button" className="conversation-markdown-link" onClick={() => onMarkdownOpen(value)}>{value}</button> : value) : part}</span>;
  });
}

// Keeps conversation file actions limited to project-relative Markdown references, not external URLs or traversal.
function projectMarkdownPath(value) {
  return /^(?:[\w.-]+\/)*[\w.-]+\.md$/.test(value) && !value.split("/").includes("..");
}

// Allows only safe external link protocols in untrusted agent Markdown.
function safeLinkHref(value) {
  const href = String(value ?? "").trim();
  return /^(https?:|mailto:)/i.test(href) ? href : null;
}

// Transforms common Markdown blocks without interpreting HTML from project files.
export function MarkdownPreviewContent({ markdown, variant = "preview", onMarkdownOpen }) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim(); const code = []; index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push(<pre key={blocks.length}><code data-language={language || undefined}>{code.join("\n")}</code></pre>); continue;
    }
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] ?? "")) {
      const headers = tableCells(line); index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) rows.push(tableCells(lines[index++]));
      blocks.push(<div className="markdown-preview-table-wrap" key={blocks.length}><table><thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}><InlineMarkdown text={cell} onMarkdownOpen={onMarkdownOpen} /></th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}><InlineMarkdown text={row[cellIndex] ?? ""} onMarkdownOpen={onMarkdownOpen} /></td>)}</tr>)}</tbody></table></div>); continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      // eslint-disable-next-line no-unused-vars -- JSX resolves the heading tag dynamically.
      const Tag = `h${heading[1].length}`;
      blocks.push(<Tag key={blocks.length}><InlineMarkdown text={heading[2]} onMarkdownOpen={onMarkdownOpen} /></Tag>); index += 1; continue;
    }
    if (/^[-*+]\s+/.test(line)) {
      const items = []; while (index < lines.length && /^[-*+]\s+/.test(lines[index])) items.push(lines[index++].replace(/^[-*+]\s+/, ""));
      blocks.push(<ul key={blocks.length}>{items.map((item, itemIndex) => <li key={itemIndex}><InlineMarkdown text={item} onMarkdownOpen={onMarkdownOpen} /></li>)}</ul>); continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items = []; while (index < lines.length && /^\d+\.\s+/.test(lines[index])) items.push(lines[index++].replace(/^\d+\.\s+/, ""));
      blocks.push(<ol key={blocks.length}>{items.map((item, itemIndex) => <li key={itemIndex}><InlineMarkdown text={item} onMarkdownOpen={onMarkdownOpen} /></li>)}</ol>); continue;
    }
    if (line.startsWith(">")) { blocks.push(<blockquote key={blocks.length}><InlineMarkdown text={line.replace(/^>\s?/, "")} onMarkdownOpen={onMarkdownOpen} /></blockquote>); index += 1; continue; }
    const paragraph = [line]; index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,4}\s|```|[-*+]\s+|\d+\.\s+|>)/.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push(<p key={blocks.length}><InlineMarkdown text={paragraph.join(" ")} onMarkdownOpen={onMarkdownOpen} /></p>);
  }
  return <div className={`markdown-preview-content markdown-preview-content--${variant}`}>{blocks}</div>;
}

// Splits a Markdown table row while ignoring optional edge pipes.
function tableCells(line) {
  return String(line).trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}
