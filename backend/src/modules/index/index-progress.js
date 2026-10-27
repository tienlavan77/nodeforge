// Tracks committed indexing work separately from database inventory and workspace readiness.
// Operations can publish these revisioned snapshots without estimating unknown scan totals.
// Function totals follow parser kinds by language; stylesheet symbols never count as functions.
export const FUNCTION_KINDS = Object.freeze({
  javascript: Object.freeze(["function", "method", "hook", "component"]),
  typescript: Object.freeze(["function", "method", "hook", "component"]),
  php: Object.freeze(["function", "method"]),
  css: Object.freeze([])
});
// Names work stages independently from durable lifecycle membership transitions.
export const INDEX_STAGES = Object.freeze(["preflight", "identity", "membership", "scan/index", "resolve", "startup/readiness"]);

// Reads a consistent database checkpoint so consumers can reconcile attempt outcomes with
// committed inventory at a named index version rather than equating processed events to files.
export function indexCheckpoint(database) {
  const read = () => {
    const files = database.all("SELECT file_id, language FROM files");
    const languages = new Map(files.map((file) => [file.file_id, file.language]));
    const functions = database.all("SELECT file_id, kind FROM symbols")
      .filter((symbol) => FUNCTION_KINDS[languages.get(symbol.file_id)]?.includes(symbol.kind)).length;
    return { version: database.all("SELECT version FROM index_metadata")[0]?.version ?? 0, files: files.length, functions };
  };
  return database.transaction ? database.transaction(read) : read();
}

// Builds an attempt-local collector. Only committed results increment indexed/deleted counts;
// resolve passes and replayed commit identities are excluded while failures remain observable.
export function createIndexProgress({ attempt = 1, onProgress = () => {}, now = () => performance.now() } = {}) {
  let lastPublishedAt = -Infinity;
  let revision = 0;
  let stage = "preflight";
  let status = "running";
  let checkpoint = null;
  const counters = { discovered: 0, eligible: 0, indexed: 0, unchanged: 0, unsupported: 0, ignored: 0, failed: 0, deleted: 0 };
  const failures = [];
  const commits = new Set();
  const stages = Object.fromEntries(INDEX_STAGES.map((name) => [name, "pending"]));
  let embedding = { status: "pending", pending: 0, processing: 0, succeeded: 0, failed: 0 };
  // Returns a detached snapshot so asynchronous consumers cannot mutate collector state.
  function snapshot() {
    return { attempt, revision, stage, status, function_kinds: FUNCTION_KINDS, stages: { ...stages }, progress: { mode: "indeterminate", total: null, percent: null, eta: null },
      counters: { ...counters }, failures: failures.map((failure) => ({ ...failure })), checkpoint: checkpoint && { ...checkpoint }, embedding: { ...embedding } };
  }
  // Publishes each state change with an increasing revision inside the current attempt.
  function publish(required = true) {
    revision += 1;
    const value = snapshot();
    const timestamp = now();
    // Routine counters share a 250 ms publication window. Mandatory boundaries flush
    // the latest counters synchronously, leaving no timers or trailing writes after settlement.
    if (required || timestamp - lastPublishedAt >= 250) {
      lastPublishedAt = timestamp;
      onProgress(value);
    }
    return value;
  }
  return Object.freeze({
    snapshot,
    // Records a required stage failure without converting preserved inventory into success.
    fail(error) { status = "failed"; stages[stage] = "failed";
      if (!failures.some((failure) => !failure.resolved)) { counters.failed += 1; failures.push({ path: "", marker: error.code ?? "index_failed", message: error.message }); } return publish(); },
    // Advances operational work independently of lifecycle membership settlement.
    stage(value) { if (!INDEX_STAGES.includes(value)) throw new Error("Unknown index progress stage.");
      if (stage !== value) stages[stage] = "completed"; stage = value; stages[value] = "running"; return publish(); },
    // Records discovered and filtered files even when they never reach the parser.
    discover(kind) { counters.discovered += 1; if (kind === "eligible") counters.eligible += 1;
      else if (kind === "ignored" || kind === "unsupported") counters[kind] += 1; return publish(false); },
    // Accepts only explicit committed index changes and keeps detailed failures retryable.
    result(result) {
      if (result.status === "resolved") return snapshot();
      const diagnosticChanged = result.status === "failed" || (result.committed === true &&
        failures.some((failure) => failure.path === result.path && !failure.resolved));
      if (result.committed && ["indexed", "deleted"].includes(result.status)) {
        const key = JSON.stringify([result.path, result.version, result.status]);
        if (commits.has(key)) return snapshot(); commits.add(key); counters[result.status] += 1;
        for (const failure of failures) if (failure.path === result.path) failure.resolved = true;
      } else if (result.status === "failed") {
        const previous = failures.find((failure) => failure.path === result.path);
        if (previous) Object.assign(previous, { marker: result.marker, message: result.message, resolved: false });
        else { counters.failed += 1; failures.push({ path: result.path, marker: result.marker, message: result.message, resolved: false }); }
      } else if (result.status === "unchanged") counters.unchanged += 1;
      return publish(diagnosticChanged);
    },
    // Reconciles the final attempt against committed inventory, preserving unresolved errors.
    reconcile(database) { checkpoint = indexCheckpoint(database); return publish(); },
    // Separates embedding diagnostics from workspace readiness and index outcome.
    embedding(value) { embedding = { ...embedding, ...value }; return publish(); },
    // Marks readiness only after the caller has completed its startup boundary.
    finish() { status = failures.some((failure) => !failure.resolved) ? "failed" : "succeeded"; stages[stage] = status === "failed" ? "failed" : "completed"; return publish(); }
  });
}
