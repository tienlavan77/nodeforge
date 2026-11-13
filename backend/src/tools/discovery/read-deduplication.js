// Read deduplication coordinates concurrent Forge source reads so parent and subagent workers reuse verified content within one delegation.
// Business purpose: prevent repeated repository reads from inflating latency and provider context while preserving project, conversation, delegation and checksum isolation.
// Technical description: maintains short-lived completed entries and in-flight promises keyed by normalized read identity; mutation callers can invalidate path entries.
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const completed = new Map();
const inFlight = new Map();

// Builds the stable identity used to share one read across compatible Forge tools and workers.
export function readDeduplicationKey({ projectRoot = "", projectId = "", conversationId = "", delegationId = "", executionId = "", path, tool = "Read", symbol = "", startLine = "", endLine = "" } = {}) {
  return [projectRoot, projectId, conversationId, delegationId, executionId, path, tool, symbol, startLine, endLine].map((value) => String(value ?? "")).join("\u001f");
}

// Executes a read once and shares its result with concurrent or recent identical requests.
export async function readWithDeduplication({ key, read, ttlMs = DEFAULT_TTL_MS, context = {}, path } = {}) {
  if (typeof key !== "string" || !key || typeof read !== "function") throw new TypeError("readWithDeduplication requires key and read.");
  const now = Date.now();
  const cached = completed.get(key);
  if (cached && cached.expiresAt > now && isFreshForContext(cached.value, context, path)) {
    return { ...cached.value, read_deduplication: { status: "cache_hit", source: cached.source, deduplicated: true } };
  }
  if (inFlight.has(key)) {
    const value = await inFlight.get(key);
    return { ...value, read_deduplication: { status: "deduplicated", source: "in_flight", deduplicated: true } };
  }
  const promise = Promise.resolve().then(read);
  inFlight.set(key, promise);
  try {
    const value = await promise;
    completed.set(key, { value, source: context?.agent_identity?.agent_id ?? "forge", expiresAt: Date.now() + ttlMs });
    return { ...value, read_deduplication: { status: "executed", source: "file_service", deduplicated: false } };
  } finally {
    inFlight.delete(key);
  }
}

// Invalidates all cached reads for a project path after a mutation or watcher update.
export function invalidateReadDeduplication({ projectRoot = "", projectId = "", path } = {}) {
  const prefix = [projectRoot, projectId].map((value) => String(value ?? "")).join("\u001f");
  for (const key of completed.keys()) if (key.startsWith(prefix) && (!path || key.includes(`\u001f${path}\u001f`))) completed.delete(key);
  for (const key of inFlight.keys()) if (key.startsWith(prefix) && (!path || key.includes(`\u001f${path}\u001f`))) inFlight.delete(key);
}

// Checks whether the cached checksum still agrees with the caller's observed evidence.
function isFreshForContext(value, context, path) {
  const observed = Array.isArray(context?.observed_files) ? context.observed_files.find((item) => item.path === path) : null;
  return !observed || !observed.sha256 || !value?.sha256 || observed.sha256 === value.sha256;
}
