// Copies selected development logs to the operator's local terminal clipboard.
// Mouse coordinates refer to a frozen viewport; OSC 52 works across SSH without
// requiring a desktop clipboard service on the development server.

/** Tracks a left-button drag, highlights its text, and copies on release so
 * operators can collect errors without entering the separate copy screen. */
export function createMouseSelection({ state, output }) {
  let start;
  let lines;
  /** Maps terminal cells into the frozen log viewport, including out-of-bounds
   * releases so dragging across the status area still completes the selection. */
  function point({ x, y }) {
    const row = Math.max(0, Math.min(lines.length - 1, y - 1));
    return { row, col: Math.max(0, Math.min(lines[row].length, x - 1)) };
  }
  /** Keeps selection rendering and clipboard extraction on the same text so
   * copied diagnostics match the highlighted content in either drag direction. */
  function onMouse(event) {
    if (event.action === "down") {
      if (!state.screenLines?.length || event.y > state.screenLines.length) return;
      lines = [...state.screenLines];
      start = point(event);
      state.selecting = true;
    }
    if (!state.selecting) return;
    const end = point(event);
    const [first, last] = start.row < end.row || start.row === end.row && start.col <= end.col ? [start, end] : [end, start];
    const selected = [];
    output.write("\x1b7");
    for (let row = 0; row < lines.length; row += 1) {
      const line = lines[row];
      const from = row === first.row ? first.col : 0;
      const to = row === last.row ? Math.min(line.length, last.col + 1) : line.length;
      const included = row >= first.row && row <= last.row;
      output.write(`\x1b[${row + 1};1H\x1b[2K${included ? `${line.slice(0, from)}\x1b[7m${line.slice(from, to)}\x1b[0m${line.slice(to)}` : line}`);
      if (included) selected.push(line.slice(from, to));
    }
    output.write("\x1b8");
    if (event.action !== "up") return;
    state.selecting = false;
    if (start.row === end.row && start.col === end.col) return;
    const text = selected.join("\n");
    if (text) output.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  }
  return Object.freeze({ onMouse });
}
