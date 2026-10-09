// Runs explicit preview/apply maintenance migration for PROJECT-NODEFORGE without exposing arbitrary database commands.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadNodeforgeEnv } from "./nodeforge-env.mjs";
import { readControlApiConfig } from "./control-api-config.mjs";
import { openSprintMigrationRuntime } from "./sprint-registry-migration-runtime.mjs";
import { migrationError } from "../src/application/sprint-registry-migration-preview.js";

// Validates the bounded administrative interface before opening runtime storage.
export function parseSprintMigrationArgs(args) {
  const [mode, ...tokens] = args;
  if (!["preview", "apply"].includes(mode) || tokens.length % 2 !== 0) throw migrationError("SPRINT_MIGRATION_INPUT", "Use preview|apply --project PROJECT-NODEFORGE with explicit option values.");
  const options = { mode };
  const allowed = mode === "preview" ? ["project", "supplements"] : ["project", "manifest", "sha256"];
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index].replace(/^--/, "");
    if (!tokens[index].startsWith("--") || !allowed.includes(key) || options[key] !== undefined || !tokens[index + 1] || tokens[index + 1].startsWith("--")) throw migrationError("SPRINT_MIGRATION_INPUT", "Unknown, duplicate or incomplete migration option.");
    options[key] = tokens[index + 1];
  }
  if (options.project !== "PROJECT-NODEFORGE") throw migrationError("SPRINT_MIGRATION_PROJECT", "This maintenance command is restricted to PROJECT-NODEFORGE.");
  if (mode === "apply" && (!options.manifest || !/^[a-f0-9]{64}$/.test(options.sha256 ?? ""))) throw migrationError("SPRINT_MIGRATION_INPUT", "Apply requires --manifest and the preview's exact --sha256.");
  return options;
}

// Executes the selected migration action and always releases offline locks and the database connection.
export async function runSprintMigration(args, config) {
  const options = parseSprintMigrationArgs(args);
  if (options.project !== config.projectId) throw migrationError("SPRINT_MIGRATION_PROJECT", "Configured runtime project does not match the requested project.");
  const manifest = options.manifest ? JSON.parse(await readFile(options.manifest, "utf8")) : null;
  const supplements = options.supplements ? JSON.parse(await readFile(options.supplements, "utf8")) : {};
  const runtime = await openSprintMigrationRuntime({ config, mode: options.mode });
  try {
    return options.mode === "preview"
      ? await runtime.service.preview({ project_id: options.project, supplements })
      : await runtime.service.apply({ project_id: options.project, manifest, manifest_sha256: options.sha256 });
  } finally { runtime.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loadNodeforgeEnv();
  try {
    const result = await runSprintMigration(process.argv.slice(2), readControlApiConfig());
    console.log(JSON.stringify(result, null, 2));
    if (result.can_apply === false) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ code: error.code ?? "SPRINT_MIGRATION_FAILED", message: error.message, retryable: false }));
    process.exitCode = 1;
  }
}
