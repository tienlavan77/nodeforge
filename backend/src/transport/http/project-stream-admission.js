// Preserves the final admission boundary between stream selection and connection. Cached stream
// handles must consult the owning runtime before subscribing, even after a successful resolution.

// Wraps only the connection boundary while retaining the stream's existing public operations.
export function guardStream(stream, assertAdmission) {
  if (!stream || !assertAdmission) return stream;
  return { ...stream,
    // Refuses stale project and conversation stream handles before they create subscriptions.
    connect(input) { assertAdmission(); return stream.connect(input); }
  };
}
