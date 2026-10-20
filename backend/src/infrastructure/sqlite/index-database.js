// Manages the SQLite index database file, WAL configuration, and incremental schema migrations for code graph storage.
import { lstatSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ConfigurationError } from "../../shared/errors.js";
import { runIndexMigrations } from "./index-migrations.js";

const DATABASE_FILE = "index.db";

// Ensures the runtime directory exists on disk and returns its resolved path for database placement.
export async function ensureRuntimeDir(projectRoot, runtimeDir) {
  assertProjectRoot(projectRoot);
  const root = resolve(projectRoot);
  const resolvedRuntimeDir = runtimeDir ? resolveRuntimeDir(root, runtimeDir) : join(root, ".forge", "runtime");
  const runtimeRelative = relative(root, resolvedRuntimeDir);
  if (isAbsolute(runtimeRelative) || runtimeRelative === ".." || runtimeRelative.startsWith(`..${sep}`)) {
    throw new ConfigurationError("Runtime directory must remain inside the project root.");
  }
  let directory;
  try {
    directory = await realpath(root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    directory = await ensureRuntimeDir(dirname(root), basename(root));
  }
  for (const component of runtimeRelative.split(sep).filter(Boolean)) {
    directory = join(directory, component);
    if (!assertRuntimeTarget(directory, true)) {
      try {
        await mkdir(directory);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    assertRuntimeTarget(directory, true);
  }
  return directory;
}

// Opens (or creates) the SQLite index database at the runtime dir, applies pragmas and runs pending migrations.
export async function openIndexDatabase(projectRoot, { busyTimeoutMs = 10000, journalMode = "WAL", runtimeDir: configuredRuntimeDir } = {}) {
  const runtimeDir = await ensureRuntimeDir(projectRoot, configuredRuntimeDir);
  const databasePath = join(runtimeDir, DATABASE_FILE);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) assertRuntimeTarget(`${databasePath}${suffix}`, false);
  const database = new DatabaseSync(databasePath);
  let closed = false;

  database.exec("PRAGMA foreign_keys = ON");
  // Multiple Node processes (API + project watcher) share this runtime DB.
  // WAL plus a busy timeout lets short writes queue instead of crashing streams.
  database.exec(`PRAGMA journal_mode = ${journalMode}`);
  database.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)}`);
  runIndexMigrations(database);

  return Object.freeze({
    databasePath,
    all(sql, parameters = []) {
      if (closed) throw new ConfigurationError("Cannot query a closed index database.");
      const statement = database.prepare(sql);
      return statement.all(...parameters).map((row) => ({ ...row }));
    },
    run(sql, parameters = []) {
      if (closed) throw new ConfigurationError("Cannot write to a closed index database.");
      return database.prepare(sql).run(...parameters);
    },
    transaction(callback) {
      if (closed) throw new ConfigurationError("Cannot transact on a closed index database.");
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = callback();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    async close() {
      if (closed) return;
      database.close();
      closed = true;
    }
  });
}

// Rejects redirected runtime storage before another project's persisted data can be opened or changed.
function assertRuntimeTarget(path, directory) {
  let status;
  try {
    status = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (status.isSymbolicLink() || (directory ? !status.isDirectory() : !status.isFile() || status.nlink !== 1)) {
    throw new ConfigurationError("Linked or invalid runtime storage is not allowed inside the project root.");
  }
  return true;
}

// Throws if projectRoot is missing or empty.
function assertProjectRoot(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new ConfigurationError("A project root is required for the index database.");
  }
}

// Resolves runtimeDir relative to projectRoot, validating it is a non-empty path.
function resolveRuntimeDir(projectRoot, runtimeDir) {
  if (typeof runtimeDir !== "string" || runtimeDir.length === 0) throw new ConfigurationError("Runtime directory must be a non-empty path.");
  return resolve(projectRoot, runtimeDir);
}
