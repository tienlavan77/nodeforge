// Reads plan table cells without treating literal code operators or escaped pipes as scope boundaries.

// Preserves complete acceptance criteria containing code spans, regex alternatives and Markdown-escaped pipes.
export function splitMarkdownTableRow(line) {
  const source = String(line).trim();
  const cells = [];
  let cell = "";
  let codeDelimiter = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      let end = index;
      while (source[end] === "\\") end += 1;
      const count = end - index;
      if (source[end] === "|" && count % 2 === 1) {
        cell += "\\".repeat(count - 1) + "|";
        index = end;
      } else {
        cell += "\\".repeat(count);
        index = end - 1;
      }
    } else if (char === "`") {
      let end = index;
      while (source[end] === "`") end += 1;
      const count = end - index;
      if (codeDelimiter === 0) codeDelimiter = count;
      else if (codeDelimiter === count) codeDelimiter = 0;
      cell += source.slice(index, end);
      index = end - 1;
    } else if (char === "|" && codeDelimiter === 0) {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells;
}
