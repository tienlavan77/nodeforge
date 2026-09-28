// Persists exclusive role ownership so ticket supervisors cannot dispatch one agent twice.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

// Coordinates profile status and ticket claims in one SQLite transaction.
export function createAgentOccupancyStore({ database, profiles, configuration, onChanged = async () => {}, logger = console, now = () => new Date().toISOString() } = {}) {
  if (typeof database?.transaction !== "function" || typeof profiles?.load !== "function") throw new ConfigurationError("Agent occupancy requires persistent profiles and transactions.");
  database.run("CREATE TABLE IF NOT EXISTS agent_occupancy (claim_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'coder', supervisor_id TEXT NOT NULL, claimed_at TEXT NOT NULL, released_at TEXT, release_reason TEXT)");
  database.run("CREATE UNIQUE INDEX IF NOT EXISTS agent_occupancy_active_agent ON agent_occupancy(agent_id) WHERE released_at IS NULL");
  if (!database.all("PRAGMA table_info(agent_occupancy)").some((column) => column.name === "role")) database.run("ALTER TABLE agent_occupancy ADD COLUMN role TEXT NOT NULL DEFAULT 'coder'");
  database.run("DROP INDEX IF EXISTS agent_occupancy_active_task");
  database.run("CREATE UNIQUE INDEX IF NOT EXISTS agent_occupancy_active_task_role ON agent_occupancy(task_id, role) WHERE released_at IS NULL");
  return Object.freeze({ claim, release, getByTask, listActive });

  // Claims a ready role atomically, or returns the existing claim for its owner.
  async function claim({ agentId, taskId, supervisorId, role = "coder" }) {
    requireIdentity(agentId, taskId, supervisorId);
    if (typeof role !== "string" || !role) throw new ConfigurationError("Agent claim requires a role.");
    const result = database.transaction(() => {
      const existing = database.all("SELECT * FROM agent_occupancy WHERE task_id = ? AND role = ? AND released_at IS NULL", [taskId, role])[0];
      if (existing) return existing.agent_id === agentId && existing.supervisor_id === supervisorId ? { ...existing, created: false } : null;
      const current = database.all("SELECT profile_json FROM agent_profiles WHERE agent_id = ?", [agentId])[0];
      if (!current) return null;
      const profile = JSON.parse(current.profile_json);
      if (profile.role !== role || profile.enabled !== true || profile.status !== "ready") return null;
      const claimedAt = now();
      const claimId = randomUUID();
      const inserted = database.run("INSERT OR IGNORE INTO agent_occupancy (claim_id, agent_id, task_id, role, supervisor_id, claimed_at) VALUES (?, ?, ?, ?, ?, ?)", [claimId, agentId, taskId, role, supervisorId, claimedAt]);
      if (!inserted.changes) return null;
      profile.status = "working"; profile.updated_at = claimedAt;
      database.run("UPDATE agent_profiles SET profile_json = ? WHERE agent_id = ?", [JSON.stringify(profile), agentId]);
      return { claim_id: claimId, agent_id: agentId, task_id: taskId, supervisor_id: supervisorId, claimed_at: claimedAt, created: true };
    });
    if (result?.created) await notifyTransition({ ...result, status: "working", previous_status: "ready" });
    return result;
  }

  // Releases only the exact supervisor claim after a terminal ticket decision.
  async function release({ claimId, taskId, supervisorId, reason }) {
    if (typeof claimId !== "string" || !claimId || typeof reason !== "string" || !reason) throw new ConfigurationError("Agent release requires claim identity and reason.");
    requireIdentity("claimed-agent", taskId, supervisorId);
    const result = database.transaction(() => {
      const current = database.all("SELECT * FROM agent_occupancy WHERE claim_id = ? AND task_id = ? AND supervisor_id = ?", [claimId, taskId, supervisorId])[0];
      if (!current || current.released_at) return null;
      const profileRow = database.all("SELECT profile_json FROM agent_profiles WHERE agent_id = ?", [current.agent_id])[0];
      const releasedAt = now();
      database.run("UPDATE agent_occupancy SET released_at = ?, release_reason = ? WHERE claim_id = ? AND released_at IS NULL", [releasedAt, reason, claimId]);
      if (profileRow) {
        const profile = JSON.parse(profileRow.profile_json);
        profile.status = profile.enabled ? "ready" : "not_connected"; profile.updated_at = releasedAt;
        database.run("UPDATE agent_profiles SET profile_json = ? WHERE agent_id = ?", [JSON.stringify(profile), current.agent_id]);
      }
      return { ...current, released_at: releasedAt, release_reason: reason, status: profileRow ? JSON.parse(profileRow.profile_json).enabled ? "ready" : "not_connected" : "not_connected" };
    });
    if (result) await notifyTransition({ ...result, previous_status: "working" });
    return result;
  }

  // Finds a ticket's durable claim during retries and process recovery.
  function getByTask(taskId, role = "coder") {
    return database.all("SELECT * FROM agent_occupancy WHERE task_id = ? AND role = ? AND released_at IS NULL", [taskId, role])[0] ?? null;
  }

  // Lists durable claims for terminal-state reconciliation after a process restart.
  function listActive() {
    return database.all("SELECT * FROM agent_occupancy WHERE released_at IS NULL");
  }

  // A post-commit cache or stream failure must not report an already persisted claim as failed.
  async function notifyTransition(event) {
    for (const [step, callback] of [["profile_reload", () => profiles.load()], ["configuration_sync", () => configuration?.sync?.()], ["event_publish", () => onChanged(event)]]) {
      try { await callback(); }
      catch (error) {
        try { logger.error?.("Agent occupancy post-commit notification failed", { step, agent_id: event.agent_id, task_id: event.task_id, claim_id: event.claim_id, error: error.message }); }
        catch (logError) { console.error("Agent occupancy notification and logging failed", { step, task_id: event.task_id, error: error.message, log_error: logError.message }); }
      }
    }
  }
}

// Refuses anonymous ownership transitions before they reach SQLite.
function requireIdentity(agentId, taskId, supervisorId) {
  if (![agentId, taskId, supervisorId].every((value) => typeof value === "string" && value)) throw new ConfigurationError("Agent claim requires agent, task, and supervisor identities.");
}
