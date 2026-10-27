/** Separates machine-readable test failures from bounded display logs. Node can
 * compare complete baseline evidence even when test logging exceeds the agent
 * output budget; redaction never rewrites JSON framing or grants acceptance. */
import { StringDecoder } from "node:string_decoder";

const TRANSIENT = /ENOSPC|no space left on device|ETIMEDOUT|ECONNRESET|cpu overloaded|\b503\b/i;
const MAX_EVIDENCE = 4 * 1024 * 1024;

/** Removes credentials from individual text values, preserving surrounding JSON
 * delimiters when older receipts or ordinary process output contain URLs. */
export function redactVerificationText(raw) {
  let value = String(raw ?? "").replace(/https?:\/\/[^\s"'<>\\]+/gi, "[REDACTED_URL]");
  value = value.replace(/(api[_-]?key|secret|token|password|authorization)[=:]\s*[^\s"'<>\\]+/gi, "$1=[REDACTED]");
  value = value.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
  for (const [name, secret] of Object.entries(process.env)) {
    if (/(?:api.?key|secret|token|password|credential)/i.test(name) && typeof secret === "string" && secret.length >= 8) value = value.split(secret).join("[REDACTED]");
  }
  return value;
}

/** Redacts structured values before serialization so literal quotes, newlines
 * and URL-like credentials cannot corrupt the verification receipt protocol. */
export function redactVerificationValue(value) {
  if (typeof value === "string") return redactVerificationText(value);
  if (Array.isArray(value)) return value.map(redactVerificationValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactVerificationValue(entry)]));
  return value;
}

/** Captures failure/summary records from the entire stdout stream independently
 * of its display prefix. Malformed, oversized or incomplete evidence fails
 * closed; it never becomes a preexisting-failure exemption. */
export function createVerificationFailureCollector() {
  const decoder = new StringDecoder("utf8");
  const events = [];
  let pending = "", invalid = false, discarding = false, bytes = 0, transient = false, tail = "";
  return { write, finish };

  /** Inspects all output for infrastructure faults and assembles UTF-8 JSON lines
   * only from stdout; stderr remains a diagnostic rather than a test result. */
  function write(stream, chunk) {
    const text = String(chunk);
    transient ||= TRANSIENT.test(tail + text);
    tail = text.slice(-256);
    if (stream !== "stdout") return;
    pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(text));
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!discarding) record(line);
      discarding = false;
    }
    if (pending.length > MAX_EVIDENCE) { invalid = true; pending = ""; discarding = true; }
  }

  /** Retains exact assertion data while discarding routine stdout and successful
   * test records from the machine evidence delivered to attribution. */
  function record(line) {
    if (!line.trim()) return;
    let entry;
    try { entry = JSON.parse(line); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; invalid = true; return; }
    if (!["failure", "summary"].includes(entry?.type)) return;
    bytes += Buffer.byteLength(line);
    if (bytes > MAX_EVIDENCE) { invalid = true; return; }
    events.push(redactVerificationValue(entry));
  }

  /** Marks a complete stream only after its terminal summary has actually been
   * observed, keeping partial process output in the technical-recovery path. */
  function finish() {
    pending += decoder.end();
    if (!discarding && pending) record(pending);
    return { version: 1, complete: !invalid && events.some(entry => entry.type === "summary"), transient_failure: transient, events };
  }
}

/** Supports injected executors using the same pre-redaction collection contract
 * as production subprocesses, without trusting a truncated display transcript. */
export function collectVerificationFailures(stdout, stderr) {
  const collector = createVerificationFailureCollector();
  collector.write("stdout", stdout ?? ""); collector.write("stderr", stderr ?? "");
  return collector.finish();
}
