import { openIndexDatabase } from "./index-database.js";

// Synchronous callers in the current stores are kept compatible while every
// mutation is wrapped in an immediate transaction at this boundary.
export async function createDatabaseService({ dataDir, busyTimeoutMs = 10000, journalMode = "WAL" } = {}) {
  const database = await openIndexDatabase(dataDir, { busyTimeoutMs, journalMode });
  let closed = false;
  let writing = false;

  function write(sql, params = []) {
    return transaction(() => database.run(sql, params));
  }
  function read(sql, params = []) {
    if (closed) throw new Error("Database service is closed.");
    return database.all(sql, params);
  }
  function transaction(callback) {
    if (closed) throw new Error("Database service is closed.");
    if (writing) return callback();
    writing = true;
    try { return database.transaction(callback); } finally { writing = false; }
  }
  async function close() { closed = true; await database.close(); }

  return Object.freeze({ databasePath: database.databasePath, write, read, transaction, close, run: write, all: read });
}
