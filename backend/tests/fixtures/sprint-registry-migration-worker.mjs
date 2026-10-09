// Exercises real process exclusion and a crash after immutable plan-file creation for migration recovery tests.
import { readFile } from "node:fs/promises";
import { openSprintMigrationRuntime } from "../../scripts/sprint-registry-migration-runtime.mjs";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";

const [mode, configJson, manifestPath] = process.argv.slice(2);
const config = JSON.parse(configJson);
let runtime;
try {
  runtime = await openSprintMigrationRuntime({ config, mode: "apply" });
  if (mode === "hold") {
    process.send({ ready: true });
    process.once("message", () => { runtime.close(); process.exit(0); });
  } else if (mode === "crash-after-file") {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const entry = manifest.entries[0];
    const files = createFileService({ projectRoot: config.cwd, allowPlanStorage: true });
    const crashFiles = { ...files,
      // Simulates abrupt death at the real file-before-index crash window, leaving locks for restart recovery.
      atomicCreate: async (input) => { await files.atomicCreate(input); process.exit(17); }
    };
    const plans = createHumanPlanStore({ projectId: config.projectId, database: runtime.database, fileService: crashFiles });
    await plans.createRevision({ planId: entry.plan_id, sprintId: entry.sprint_id, expectedRevision: 0, content: entry.content });
    throw new Error("Crash injection did not exit.");
  } else throw new Error("Unknown migration fixture mode.");
} catch (error) {
  console.error(error);
  runtime?.close();
  process.exit(1);
}
