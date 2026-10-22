// Emits structured regression failures so Node can compare ticket and baseline behavior without parsing TAP prose.

// Retains assertion meaning while dropping stack locations and volatile execution timings.
function failure(error) {
  const actual = error?.cause ?? error;
  return { message: actual?.message, code: actual?.code, name: actual?.name,
    expected: actual?.expected instanceof RegExp ? { type: "RegExp", source: actual.expected.source, flags: actual.expected.flags } : actual?.expected,
    actual: actual?.actual, operator: actual?.operator };
}

// Streams bounded, machine-readable failure evidence for one regression test process.
export default async function* report(source) {
  for await (const { type, data } of source) {
    if (type === "test:fail" && data.details?.error?.failureType !== "subtestsFailed") {
      yield `${JSON.stringify({ type: "failure", name: data.name, file: data.file, line: data.line, column: data.column,
        error: failure(data.details?.error) }, (_key, value) => typeof value === "bigint" ? String(value) : value)}\n`;
    }
    if (type === "test:summary" && data.file === undefined) yield `${JSON.stringify({ type: "summary", failed: data.counts.failed, cancelled: data.counts.cancelled })}\n`;
    if (["test:stdout", "test:stderr"].includes(type)) yield `${JSON.stringify({ type: "output", text: data.message })}\n`;
  }
}
