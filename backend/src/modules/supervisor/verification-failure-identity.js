// Compares violated test predicates without treating unrelated prompt prose as a newly introduced regression.

// Retains strict error identity except for fully recorded string-to-regex assertions with a verified failed predicate.
export function verificationFailureIdentity(event) {
  const error = event.error;
  const expected = error?.expected;
  if (error?.code !== "ERR_ASSERTION" || error.name !== "AssertionError" || error.operator !== "match"
    || typeof error.actual !== "string" || expected?.type !== "RegExp" || typeof expected.source !== "string"
    || typeof expected.flags !== "string" || typeof event.file !== "string" || !event.file
    || !Number.isInteger(event.line) || event.line < 1 || !Number.isInteger(event.column) || event.column < 1) return event;
  let pattern;
  try { pattern = new RegExp(expected.source, expected.flags); }
  catch (cause) { if (cause instanceof SyntaxError) return event; throw cause; }
  // A mislabeled matching value cannot supply evidence for a pre-existing failed assertion.
  if (pattern.test(error.actual)) return event;
  return { type: event.type, name: event.name, file: event.file, line: event.line, column: event.column,
    error: { code: error.code, name: error.name, operator: error.operator, expected,
      actual_type: "string", predicate_result: false } };
}
