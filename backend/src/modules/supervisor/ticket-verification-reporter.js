// Emits structured regression failures so Node can compare ticket and baseline behavior without parsing TAP prose.
import { verificationFailureIdentity } from "./verification-failure-identity.js";

// Retains assertion meaning while dropping stack locations and volatile execution timings.
function failure(error) {
  const actual = error?.cause ?? error;
  return { message: actual?.message, code: actual?.code, name: actual?.name,
    expected: actual?.expected instanceof RegExp ? { type: "RegExp", source: actual.expected.source, flags: actual.expected.flags } : actual?.expected,
    actual: actual?.actual, operator: actual?.operator };
}

// Evaluates string-to-regex assertions before dropping duplicated prompt dumps. The
// receipt preserves the exact failed predicate and source identity for baseline
// comparison; infrastructure diagnostics and other assertion types remain unchanged.
function compactFailure(event) {
  const compact = verificationFailureIdentity(event);
  if (compact === event || /ENOSPC|no space left on device|ETIMEDOUT|ECONNRESET|cpu overloaded|\b503\b/i.test(JSON.stringify(event.error))) return event;
  return { ...compact, error: { ...compact.error, message: "String did not match the recorded regular expression." } };
}

// Streams bounded, machine-readable failure evidence for one regression test process.
export default async function* report(source) {
  for await (const { type, data } of source) {
    if (type === "test:fail" && data.details?.error?.failureType !== "subtestsFailed") {
      yield `${JSON.stringify(compactFailure({ type: "failure", name: data.name, file: data.file, line: data.line, column: data.column,
        error: failure(data.details?.error) }), (_key, value) => typeof value === "bigint" ? String(value) : value)}\n`;
    }
    if (type === "test:summary" && data.file === undefined) yield `${JSON.stringify({ type: "summary", failed: data.counts.failed, cancelled: data.counts.cancelled })}\n`;
    if (["test:stdout", "test:stderr"].includes(type)) yield `${JSON.stringify({ type: "output", text: data.message })}\n`;
  }
}
