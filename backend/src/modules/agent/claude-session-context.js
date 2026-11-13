// Business purpose: restores trustworthy Claude context occupancy when SDK usage is incomplete.
// Technical description: reads bounded tails from conversation-scoped and legacy Claude transcripts.
import { openSync, closeSync, fstatSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function readClaudeSessionContext(home, sessionId, output = process.stderr) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  let projects = [];
  try {
    const projectRoot = join(home, "projects");
    projects = readdirSync(projectRoot, { withFileTypes: true }).map((project) => ({ name: project.name, directory: project.isDirectory(), root: projectRoot }));
  } catch (error) {
    if (error.code !== "ENOENT") output?.write?.(`[nodeforge] Claude context directory probe failed: ${error.message}\n`);
    return null;
  }
  let latest = null;
  for (const project of projects) {
    if (!project.directory) continue;
    let descriptor;
    try {
      descriptor = openSync(join(project.root, project.name, `${sessionId}.jsonl`), "r");
      const size = fstatSync(descriptor).size;
      const buffer = Buffer.alloc(Math.min(size, 1024 * 1024));
      const offset = Math.max(0, size - buffer.length);
      const count = readSync(descriptor, buffer, 0, buffer.length, offset);
      const lines = buffer.subarray(0, count).toString("utf8").split("\n");
      if (offset > 0) lines.shift();
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const usage = entry.type === "assistant" ? entry.message?.usage : null;
        if (!usage) continue;
        const values = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens].map((value) => Number(value ?? 0));
        if (!values.every((value) => Number.isFinite(value) && value >= 0)) continue;
        const tokens = values[0] + Math.max(values[1], values[2]);
        const timestamp = String(entry.timestamp ?? "");
        if (tokens > 0 && (!latest || timestamp >= latest.timestamp)) latest = { timestamp, tokens };
      }
    } catch (error) {
      if (error.code !== "ENOENT") output?.write?.(`[nodeforge] Claude transcript probe failed: ${error.message}\n`);
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  return latest?.tokens ?? null;
}
