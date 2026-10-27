// Coalesces concurrent Add and retry requests by canonical project root so one startup
// attempt supplies every caller with the same success or failure. The lifecycle mutation
// queue still owns admission ordering and all filesystem, identity and membership checks.
// Removing settled promises permits a later explicit retry without retaining old diagnostics.

// Builds a lifecycle-local admission coordinator; canonical aliases share pending startup
// work, while settlement releases the key before callers can request another attempt.
export function createProjectAdmissionQueue({ canonicalRoot, enqueue, admit }) {
  const pending = new Map();
  // Resolves project aliases before selecting the shared promise. Cleanup belongs to that
  // promise, including rejection, so queued callers cannot silently start a second attempt.
  return async function add(root) {
    const canonical = await canonicalRoot(root);
    if (!pending.has(canonical)) {
      const attempt = enqueue(() => admit(root)).finally(() => pending.delete(canonical));
      pending.set(canonical, attempt);
    }
    return pending.get(canonical);
  };
}
