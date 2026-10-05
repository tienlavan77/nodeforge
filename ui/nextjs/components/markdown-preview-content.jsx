"use client";
// Renders a safe, readable Markdown document in the project-file preview panel.

// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
function InlineMarkdown({ text }) {
  const parts = String(text ?? "").split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => part.startsWith("`") ? <code key={index}>{part.slice(1, -1)}</code> : part.startsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : <span key={index}>{part}</span>);
}

// Transforms common Markdown blocks without interpreting HTML from project files.
export function MarkdownPreviewContent({ markdown }) {
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
      blocks.push(<div className="markdown-preview-table-wrap" key={blocks.length}><table><thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}><InlineMarkdown text={cell} /></th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}><InlineMarkdown text={row[cellIndex] ?? ""} /></td>)}</tr>)}</tbody></table></div>); continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      // eslint-disable-next-line no-unused-vars -- JSX resolves the heading tag dynamically.
      const Tag = `h${heading[1].length}`;
      blocks.push(<Tag key={blocks.length}><InlineMarkdown text={heading[2]} /></Tag>); index += 1; continue;
    }
    if (/^[-*+]\s+/.test(line)) {
      const items = []; while (index < lines.length && /^[-*+]\s+/.test(lines[index])) items.push(lines[index++].replace(/^[-*+]\s+/, ""));
      blocks.push(<ul key={blocks.length}>{items.map((item, itemIndex) => <li key={itemIndex}><InlineMarkdown text={item} /></li>)}</ul>); continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items = []; while (index < lines.length && /^\d+\.\s+/.test(lines[index])) items.push(lines[index++].replace(/^\d+\.\s+/, ""));
      blocks.push(<ol key={blocks.length}>{items.map((item, itemIndex) => <li key={itemIndex}><InlineMarkdown text={item} /></li>)}</ol>); continue;
    }
    if (line.startsWith(">")) { blocks.push(<blockquote key={blocks.length}><InlineMarkdown text={line.replace(/^>\s?/, "")} /></blockquote>); index += 1; continue; }
    const paragraph = [line]; index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,4}\s|```|[-*+]\s+|\d+\.\s+|>)/.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push(<p key={blocks.length}><InlineMarkdown text={paragraph.join(" ")} /></p>);
  }
  return <div className="markdown-preview-content">{blocks}</div>;
}

// Splits a Markdown table row while ignoring optional edge pipes.
function tableCells(line) {
  return String(line).trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}
