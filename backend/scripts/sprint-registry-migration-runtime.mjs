// Adapts migration to the configured control database with read-only preview and exclusive offline apply.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, lstat, copyFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acquireProcessLock } from "./nodeforge-process-lock.mjs";
import { createFileService } from "../src/infrastructure/filesystem/file-service.js";
import { createHumanPlanStore } from "../src/modules/governance/human-plan-store.js";
import { createSprintRegistry } from "../src/modules/governance/sprint-registry.js";
import { createTicketFileStore } from "../src/application/ticket-file-store.js";
import { createSprintRegistryMigrationService } from "../src/application/sprint-registry-migration-service.js";
import { recoverSprintMigrationPlan } from "../src/application/sprint-registry-migration-plan-recovery.js";
import { migrationError, migrationHash } from "../src/application/sprint-registry-migration-preview.js";

// Opens existing storage only; preview never runs schema migrations or acquires runtime lock files.
export async function openSprintMigrationRuntime({ config, mode }) {
  if (!["preview", "apply"].includes(mode)) throw migrationError("SPRINT_MIGRATION_INPUT", "Mode must be preview or apply.");
  const locks = [];
  let raw;
  try {
    if (mode === "apply") {
      locks.push(acquireProcessLock(config.dataDir, "control"));
      locks.push(acquireProcessLock(config.dataDir, "watcher"));
    }
    const databasePath = resolve(config.dataDir, "index.db");
    // Existing-file verification prevents apply from accidentally creating an empty database.
    if (!(await lstat(databasePath)).isFile()) throw migrationError("SPRINT_MIGRATION_RUNTIME", "Configured database is not an existing regular file.");
    raw = new DatabaseSync(databasePath, { readOnly: mode === "preview" });
    raw.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000");
    let transactionActive = false;
    const database = {
      databasePath,
      // Reads fixed application queries; this adapter is never exposed as an arbitrary SQL tool.
      all(sql, params = []) { return raw.prepare(sql).all(...params).map((row) => ({ ...row })); },
      // Rejects accidental writes from preview services before reaching SQLite.
      run(sql, params = []) {
        if (mode !== "apply") throw migrationError("SPRINT_MIGRATION_READ_ONLY", "Preview cannot write database state.");
        return raw.prepare(sql).run(...params);
      },
      // Serializes synchronous index writes and provides a coherent read transaction for source capture.
      transaction(action) {
        if (transactionActive) return action();
        raw.exec(mode === "apply" ? "BEGIN IMMEDIATE" : "BEGIN");
        transactionActive = true;
        try { const result = action(); raw.exec("COMMIT"); return result; }
        catch (error) { raw.exec("ROLLBACK"); throw error; }
        finally { transactionActive = false; }
      }
    };
    const files = createFileService({ projectRoot: config.cwd, allowPlanStorage: true });
    const plans = createHumanPlanStore({ projectId: config.projectId, database, fileService: files });
    const registry = createSprintRegistry({ projectId: config.projectId, database, plans });
    const tickets = createTicketFileStore({ database, fileService: files });
    // Captures current and historical Sprint sources, persisted ticket histories and their source identity.
    const readSource = () => database.transaction(() => {
      const versions = database.all("SELECT sequence,roadmap_json FROM governance_roadmaps ORDER BY sequence");
      const roadmaps = versions.map((row) => ({ sequence: row.sequence, roadmap: JSON.parse(row.roadmap_json) }));
      const current = roadmaps.at(-1)?.roadmap ?? null;
      const latestSprintSources = new Map();
      for (const { sequence, roadmap } of roadmaps) {
        if (roadmap.project_id !== config.projectId) continue;
        for (const sprint of roadmap.sprints ?? []) latestSprintSources.set(sprint.id, { sequence, sprint });
      }
      const metadata = tickets.listMetadata({ projectId: config.projectId }).map((row) => ({ ...row, latest: tickets.readLatest(row.id) ?? null, ticket_file_sha256: createHash("sha256").update(files.readFileSync({ path: row.ticket_file })).digest("hex") }));
      const ticketDeletions = database.all("SELECT event_id,timestamp,source,event_json FROM events WHERE project_id=? AND event_type='ticket.deleted' ORDER BY sequence", [config.projectId]).map((row) => {
        const event = JSON.parse(row.event_json);
        return { project_id: config.projectId, event_id: row.event_id, event_type: "ticket.deleted", source: row.source, timestamp: row.timestamp, ticket_id: event.payload?.ticket_id, sprint_id: event.payload?.sprint_id };
      }).filter((entry) => entry.source === "sprint-plan-service" && entry.ticket_id && entry.sprint_id);
      return {
        runtime: { project_root: resolve(config.cwd), database_path: databasePath },
        roadmap: current,
        historical_sprints: [...latestSprintSources.values()].map(({ sequence, sprint }) => ({ sequence, ...sprint })),
        roadmap_history_sha256: migrationHash(roadmaps.map(({ sequence, roadmap }) => ({ sequence, sha256: createHash("sha256").update(JSON.stringify(roadmap)).digest("hex") }))),
        metadata,
        ticket_deletions: ticketDeletions,
        ticket_status: database.all("SELECT * FROM ticket_status WHERE project_id=? ORDER BY ticket_id", [config.projectId])
      };
    });
    const service = createSprintRegistryMigrationService({
      projectId: config.projectId, readSource, registry, plans,
      recoverPlan: (entry) => recoverSprintMigrationPlan({ projectId: config.projectId, entry, database, fileService: files, plans }),
      // Apply runs offline while holding both production process locks; it never stops a live process itself.
      withMaintenance: mode === "apply" ? (action) => action() : undefined,
      // Creates a consistent SQLite backup plus immutable plans, ticket history and source manifest before import.
      backup: async ({ manifest, source }) => {
        const path = join(config.dataDir, "sprint-migration-backups", `${manifest.manifest_sha256}-${randomUUID()}`);
        await mkdir(path, { recursive: true, mode: 0o700 });
        const backupDb = join(path, "index.db");
        raw.prepare("VACUUM INTO ?").run(backupDb);
        await chmod(backupDb, 0o600);
        await copyMigrationTree(join(config.cwd, ".forge/runtime/nf/plans"), join(path, "plans"));
        await copyMigrationTree(join(config.cwd, ".forge/runtime/nf/tickets"), join(path, "tickets"));
        await writeFile(join(path, "source.json"), JSON.stringify({ manifest, source }), { flag: "wx", mode: 0o600 });
        const hashes = await migrationTreeHashes(path);
        const sha256 = migrationHash(hashes);
        await writeFile(join(path, "backup-manifest.json"), JSON.stringify({ sha256, files: hashes }), { flag: "wx", mode: 0o600 });
        return { path, sha256 };
      },
      // Retains an append-only receipt even when a later retry needs to reconcile partial state.
      writeReceipt: async (receipt) => {
        const directory = join(config.dataDir, "sprint-migration-receipts");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `${receipt.manifest_sha256}-${randomUUID()}.json`);
        await writeFile(path, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
        return path;
      }
    });
    return { service, database, plans, registry, readSource, close: () => { raw.close(); for (const lock of locks.reverse()) lock.release(); } };
  } catch (error) {
    raw?.close();
    for (const lock of locks.reverse()) lock.release();
    throw error;
  }
}

// Copies backup trees without following symlinks into unrelated or sensitive filesystem locations.
async function copyMigrationTree(source, target) {
  let info;
  try { info = await lstat(source); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (info.isSymbolicLink()) throw migrationError("SPRINT_MIGRATION_BACKUP_PATH", "Backup source contains a symlink; reconcile its storage path first.");
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const name of (await readdir(source)).sort()) await copyMigrationTree(join(source, name), join(target, name));
  } else if (info.isFile()) { await copyFile(source, target); await chmod(target, 0o600); }
  else throw migrationError("SPRINT_MIGRATION_BACKUP_PATH", "Backup source is not a regular file or directory.");
}

// Binds every backup file to a digest so operators can verify a restore bundle before using it.
async function migrationTreeHashes(root, prefix = "") {
  const result = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(join(root, relative));
    if (info.isDirectory()) result.push(...await migrationTreeHashes(root, relative));
    else result.push({ path: relative, sha256: createHash("sha256").update(await readFile(join(root, relative))).digest("hex") });
  }
  return result;
}
