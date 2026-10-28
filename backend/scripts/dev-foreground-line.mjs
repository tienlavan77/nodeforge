// Preserves the foreground controller's existing source colors while coloring
// only result suffixes. Clipping keeps the outcome visible on narrow terminals;
// plain output remains suitable for copying and saving as a diagnostic artifact.
import { StringDecoder } from "node:string_decoder";

/** Retains the service palette already used by the development terminal. */
const SERVICE_COLORS = { api: "36", ui: "32", watcher: "35", system: "33" };
/** Distinguishes actionable outcomes without recoloring agent names or content. */
const RESULT_COLORS = { SUCCESS: "32", FAIL: "31", WAIT: "33", RETRY: "33" };

/** Formats one service line after character-based clipping, so ANSI escape
 * bytes do not consume viewport width or hide the final success/failure result. */
export function formatForegroundLine({ name, line }, { width = Infinity, color = true } = {}) {
  const source = String(name).toLowerCase(), label = `[${source.toUpperCase()}]`;
  // eslint-disable-next-line no-control-regex -- Strip provider ANSI before measuring the visible terminal line.
  const plain = String(line).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/ - OK$/, " - SUCCESS");
  const match = / - (SUCCESS|FAIL|WAIT|RETRY|WARN|INFO|STOP|DONE)$/.exec(plain);
  const suffix = match?.[0] ?? "";
  const available = Math.max(0, width - label.length - 1);
  let content = plain;
  if (content.length > available) {
    const bodyWidth = Math.max(0, available - suffix.length - 1);
    content = suffix && available >= suffix.length + 1 ? `${plain.slice(0, bodyWidth)}…${suffix}` : plain.slice(0, available);
  }
  if (!color) return `${label} ${content}`;
  const resultColor = RESULT_COLORS[match?.[1]];
  if (resultColor && content.endsWith(suffix)) content = `${content.slice(0, -suffix.length)} - \x1b[${resultColor}m${match[1]}\x1b[0m`;
  return `\x1b[${SERVICE_COLORS[source] ?? "37"}m${label}\x1b[0m ${content}`;
}

/** Reassembles UTF-8 service output into complete lines before adding source
 * labels, preventing split writes from turning one tool result into two logs. */
export function createForegroundLogReceiver(onLine) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  // Delivers complete logical lines while retaining a partial final write.
  const receive = (chunk) => {
    pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) onLine(line);
  };
  receive.finish = () => {
    receive(decoder.end());
    if (pending) onLine(pending);
    pending = "";
  };
  return receive;
}
