// Parses terminal key input so stray mouse reports never leak into the prompt.
//
// Clicks and scroll wheels arrive as multi-byte escape sequences (SGR or X10
// mouse reports) that are longer than a fixed-width parser consumes, so their
// trailing digits used to fall through into the command line. This parser
// swallows whole sequences instead: wheel motion scrolls the log, every other
// mouse report is dropped, and plain keys pass through untouched.
export function createKeyParser({ onKey, onWheel, onEscape } = {}) {
  let pending = "";
  return Object.freeze({ push });

  // Feeds one stdin chunk through the parser, holding back any trailing
  // partial sequence until the rest of its bytes arrive.
  function push(chunk) {
    pending += String(chunk ?? "");
    let text = "";
    let index = 0;
    while (index < pending.length) {
      if (pending[index] !== "\x1b") { text += pending[index]; index += 1; continue; }
      const consumed = consumeSequence(index);
      if (consumed < 0) break;
      index += consumed;
    }
    pending = pending.slice(index);
    for (const char of text) onKey?.(char);
  }

  // Consumes one escape sequence at the given offset, or -1 when its bytes
  // have not all arrived yet. Mouse reports are swallowed here: wheel motion
  // scrolls via onWheel, clicks and drags are dropped silently.
  function consumeSequence(at) {
    const next = pending[at + 1];
    if (next === undefined) return -1;
    if (next === "[") return consumeCsi(at);
    if (next === "O") return consumeFixed(at, 3, (sequence) => onEscape?.(sequence));
    if (next === "]") return consumeUntil(at, ["\x07", "\x1b\\"], () => {});
    if (next === "P" || next === "X" || next === "^" || next === "_") return consumeUntil(at, ["\x1b\\"], () => {});
    if (next === "(" || next === ")" || next === "#" || next === "%") return consumeFixed(at, 3, () => {});
    return consumeFixed(at, 2, (sequence) => onEscape?.(sequence));
  }

  // Consumes a CSI sequence: SGR/X10 mouse reports plus ordinary key codes.
  function consumeCsi(at) {
    if (pending[at + 2] === "M") {
      if (pending.length < at + 6) return -1;
      handleX10Button(pending.charCodeAt(at + 3) - 32);
      return 6;
    }
    if (pending[at + 2] === "<") {
      const end = scanSgrEnd(at + 3);
      if (end === -2) return consumeGenericCsi(at);
      if (end < 0) return -1;
      handleSgrMouse(pending.slice(at + 3, end), pending[end]);
      return end - at + 1;
    }
    return consumeGenericCsi(at);
  }

  // Consumes an ordinary key CSI sequence, forwarding it as an escape event.
  function consumeGenericCsi(at) {
    let end = at + 2;
    while (end < pending.length && /[0-9:;<=>?]/.test(pending[end])) end += 1;
    while (end < pending.length && /[ !"#$%&'()*+,-./]/.test(pending[end])) end += 1;
    if (end >= pending.length) return -1;
    if (!/[@-~]/.test(pending[end])) return end - at + 1;
    onEscape?.(pending.slice(at, end + 1));
    return end - at + 1;
  }

  // Finds the final byte of an SGR mouse report, or -1 while incomplete.
  function scanSgrEnd(from) {
    let end = from;
    while (end < pending.length && /[0-9;]/.test(pending[end])) end += 1;
    if (end >= pending.length) return -1;
    return /[Mm]/.test(pending[end]) ? end : -2;
  }

  // Handles one SGR mouse report: wheel motion scrolls, the rest is dropped.
  function handleSgrMouse(params, final) {
    if (final !== "M" && final !== "m") return;
    const button = Number(params.split(";")[0]);
    if (button === 64) onWheel?.(1);
    else if (button === 65) onWheel?.(-1);
  }

  // Handles one X10 mouse button byte with the same wheel mapping as SGR.
  function handleX10Button(button) {
    if (button === 64) onWheel?.(1);
    else if (button === 65) onWheel?.(-1);
  }

  // Consumes a fixed-width sequence, or -1 while its bytes are missing.
  function consumeFixed(at, width, done) {
    if (pending.length < at + width) return -1;
    done(pending.slice(at, at + width));
    return width;
  }

  // Consumes through the first terminator found, or -1 while none arrived.
  function consumeUntil(at, terminators, done) {
    for (const terminator of terminators) {
      const found = pending.indexOf(terminator, at + 2);
      if (found >= 0) { done(); return found + terminator.length - at; }
    }
    if (pending.length - at > 4096) return pending.length - at;
    return -1;
  }
}
