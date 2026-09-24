// Persists durable embedding jobs shared by the Watcher and Embedding Worker.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

const ACTIVE_STATUSES = ["pending", "processing", "retry_wait"];

// Creates the SQLite-backed embedding job store.
export function createEmbeddingJobStore({ database, clock = () => new Date() } = {}) {
  if (!database || typeof database.all !== "function" || typeof database.run !== "function") throw new ConfigurationError("Embedding job store requires a database.");
  if (typeof clock !== "function") throw new ConfigurationError("Embedding job store clock must be a function.");
  return Object.freeze({ enqueue, claimNext, recoverProcessing, complete, retry, supersede, counts });

  // Enqueues only the latest checksum for a symbol and supersedes older work.
  function enqueue({ symbolId, contentChecksum, model, priority = 100 } = {}) {
    assertJobInput({ symbolId, contentChecksum, model });
    const now = clock().toISOString();
    return database.transaction?.(() => insert()) ?? insert();

    function insert() {
      const existing = database.all(
        `SELECT * FROM embedding_jobs WHERE symbol_id = ? AND model = ? AND content_checksum = ? AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 1`,
        [symbolId, model, contentChecksum, ...ACTIVE_STATUSES]
      )[0];
      if (existing) return existing;
      database.run(
        `UPDATE embedding_jobs SET status = 'superseded', updated_at = ? WHERE symbol_id = ? AND model = ? AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})`,
        [now, symbolId, model, ...ACTIVE_STATUSES]
      );
      const job = {
        job_id: `EMB-${randomUUID()}`,
        symbol_id: symbolId,
        content_checksum: contentChecksum,
        model,
        status: "pending",
        priority: Number.isInteger(priority) ? priority : 100,
        attempts: 0,
        next_retry_at: null,
        last_error: null,
        created_at: now,
        updated_at: now
      };
      database.run(
        `INSERT INTO embedding_jobs (job_id, symbol_id, content_checksum, model, status, priority, attempts, next_retry_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [job.job_id, job.symbol_id, job.content_checksum, job.model, job.status, job.priority, job.attempts, job.next_retry_at, job.last_error, job.created_at, job.updated_at]
      );
      return job;
    }
  }

  // Claims the oldest ready job atomically for one worker.
  function claimNext({ now = clock().toISOString() } = {}) {
    const claim = () => {
      const job = database.all(
        `SELECT * FROM embedding_jobs WHERE status IN ('pending', 'retry_wait') AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY priority ASC, created_at ASC LIMIT 1`,
        [now]
      )[0];
      if (!job) return null;
      const result = database.run(
        "UPDATE embedding_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE job_id = ? AND status IN ('pending', 'retry_wait')",
        [now, job.job_id]
      );
      return Number(result.changes ?? 0) === 1 ? { ...job, status: "processing", attempts: Number(job.attempts ?? 0) + 1, updated_at: now } : null;
    };
    return database.transaction?.(claim) ?? claim();
  }

  // Requeues jobs left in-flight by a watcher process that stopped unexpectedly.
  function recoverProcessing({ now = clock().toISOString(), reason = "Recovered after embedding worker restart." } = {}) {
    const result = database.run(
      "UPDATE embedding_jobs SET status = 'retry_wait', next_retry_at = ?, last_error = ?, updated_at = ? WHERE status = 'processing'",
      [now, reason, now]
    );
    return Number(result.changes ?? 0);
  }

  // Marks a successfully persisted vector as complete.
  function complete(jobId) {
    return updateStatus(jobId, "completed", null, null);
  }

  // Schedules a failed job for retry or marks it permanently failed.
  function retry(jobId, error, { maxAttempts = 5, delayMs = 30000 } = {}) {
    const job = database.all("SELECT attempts FROM embedding_jobs WHERE job_id = ?", [jobId])[0];
    if (!job) return null;
    const now = clock();
    const attempts = Number(job.attempts ?? 0);
    const terminal = attempts >= maxAttempts;
    const nextRetry = terminal ? null : new Date(now.getTime() + delayMs * Math.max(1, attempts)).toISOString();
    return updateStatus(jobId, terminal ? "failed" : "retry_wait", errorMessage(error), nextRetry);
  }

  // Marks a job obsolete after its source checksum changed or its symbol disappeared.
  function supersede(jobId) {
    return updateStatus(jobId, "superseded", null, null);
  }

  // Returns queue counts for operational health checks.
  function counts() {
    return Object.fromEntries(database.all("SELECT status, COUNT(*) AS count FROM embedding_jobs GROUP BY status").map((row) => [row.status, Number(row.count)]));
  }

  function updateStatus(jobId, status, lastError, nextRetryAt) {
    if (typeof jobId !== "string" || !jobId) throw new ConfigurationError("Embedding job id is required.");
    const now = clock().toISOString();
    const result = database.run("UPDATE embedding_jobs SET status = ?, last_error = ?, next_retry_at = ?, updated_at = ? WHERE job_id = ?", [status, lastError, nextRetryAt, now, jobId]);
    return Number(result.changes ?? 0) === 1;
  }
}

// Computes the checksum shared by the indexer, backfill and worker.
export function checksumEmbeddingText(value) {
  let hash = 5381;
  for (let index = 0; index < String(value).length; index += 1) hash = ((hash * 33) ^ String(value).charCodeAt(index)) >>> 0;
  return `djb2:${hash.toString(16)}`;
}

function assertJobInput({ symbolId, contentChecksum, model }) {
  if (typeof symbolId !== "string" || !symbolId) throw new ConfigurationError("Embedding job symbol_id is required.");
  if (typeof contentChecksum !== "string" || !contentChecksum) throw new ConfigurationError("Embedding job content_checksum is required.");
  if (typeof model !== "string" || !model) throw new ConfigurationError("Embedding job model is required.");
}

function errorMessage(error) {
  return typeof error?.message === "string" && error.message ? error.message.slice(0, 2000) : String(error ?? "Unknown embedding error");
}
