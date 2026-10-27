// Persists a project's notebook independently of conversations and watcher indexes.
// Conditional mutations hold an immediate SQLite transaction through both the write
// and missing/conflict classification, preventing stale clients from losing updates.
import { randomUUID } from "node:crypto";

/** Creates an error with an HTTP-compatible status for downstream application adapters. */
function ideaError(message, status, code) {
  return Object.assign(new Error(message), { status, statusCode: status, ...(code ? { code } : {}) });
}

/** Binds every notebook operation to one project, including conflict existence probes. */
export function createIdeasStore({ controlDb, projectId, clock = () => new Date(), createId = () => randomUUID() } = {}) {
  if (!controlDb?.transaction || !controlDb?.run || !controlDb?.all || !projectId) {
    throw new TypeError("A control database and project ID are required for Ideas.");
  }
  /**
   * Resolves only the identifier and owning project metadata for an Idea record without reading or exposing notebook content, allowing upstream authorization boundaries to verify caller project permissions before any data access or mutation occurs.
   */
  function locate(id) {
    if (typeof id !== "string" || !id.trim()) return undefined;
    const row = controlDb.all("SELECT id, project_id FROM ideas WHERE project_id = ? AND id = ?", [projectId, id])[0]
      ?? controlDb.all("SELECT id, project_id FROM idea_deletions WHERE project_id = ? AND id = ?", [projectId, id])[0];
    return row ? Object.freeze({ id: row.id, project_id: row.project_id }) : undefined;
  }
  /** Reads only records belonging to this store's project. */
  function get(id) {
    return controlDb.all("SELECT * FROM ideas WHERE project_id = ? AND id = ?", [projectId, id])[0];
  }
  /** Rejects invalid content or workflow values before they reach durable storage. */
  function validate(content, status) {
    if (typeof content !== "string" || !content.trim() || !["open", "done"].includes(status)) {
      throw ideaError("Invalid Idea content or status.", 400);
    }
  }
  /** Classifies a failed conditional write while retaining the writer lock. */
  function missing(id) {
    const exists = Boolean(get(id) || controlDb.all(
      "SELECT version FROM idea_deletions WHERE project_id = ? AND id = ?", [projectId, id])[0]);
    throw ideaError(exists ? "Idea version conflict." : "Idea not found.", exists ? 409 : 404);
  }
  return Object.freeze({
    projectId,
    locate,
    get,
    /** Lists the project's notebook deterministically, optionally filtering workflow status. */
    list({ status = "all" } = {}) {
      if (!["all", "open", "done"].includes(status)) throw ideaError("Invalid Idea status.", 400);
      return controlDb.all(`SELECT * FROM ideas WHERE project_id = ?${status === "all" ? "" : " AND status = ?"} ORDER BY created_at, id`,
        status === "all" ? [projectId] : [projectId, status]);
    },
    /** Saves a new Idea with a server-owned identity, timestamps and initial version. */
    create({ content, status = "open" } = {}) {
      validate(content, status);
      const id = createId();
      const now = clock().toISOString();
      return controlDb.transaction(() => {
        controlDb.run("INSERT INTO ideas (id, project_id, content, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1)",
          [id, projectId, content, status, now, now]);
        return get(id);
      });
    },
    /** Applies partial notebook edits only when the caller still owns the saved version. */
    update(id, { version, content, status } = {}) {
      if (!Number.isSafeInteger(version) || version < 1) throw ideaError("Invalid Idea version.", 400);
      return controlDb.transaction(() => {
        const current = get(id);
        if (!current) return missing(id);
        const nextContent = content === undefined ? current.content : content;
        const nextStatus = status === undefined ? current.status : status;
        validate(nextContent, nextStatus);
        const result = controlDb.run(`UPDATE ideas SET content = ?, status = ?, updated_at = ?, version = version + 1
          WHERE project_id = ? AND id = ? AND version = ?`,
          [nextContent, nextStatus, clock().toISOString(), projectId, id, version]);
        if (!Number(result.changes)) return missing(id);
        return get(id);
      });
    },
    /** Deletes only the caller's saved revision and distinguishes stale from absent records. */
    delete(id, { version } = {}) {
      if (!Number.isSafeInteger(version) || version < 1) throw ideaError("Invalid Idea version.", 400);
      return controlDb.transaction(() => {
        const result = controlDb.run("DELETE FROM ideas WHERE project_id = ? AND id = ? AND version = ?", [projectId, id, version]);
        if (!Number(result.changes)) return missing(id);
        controlDb.run(`INSERT INTO idea_deletions (project_id, id, version) VALUES (?, ?, ?)
          ON CONFLICT (project_id, id) DO UPDATE SET version = excluded.version`, [projectId, id, version]);
        return true;
      });
    }
  });
}
