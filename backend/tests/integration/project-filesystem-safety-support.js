// Supplies isolated filesystem admission fixtures without starting external index or worker services.
// The runtime stub observes the persisted catalog at startup, making membership ordering executable.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectLifecycle } from "../../src/modules/projects/project-lifecycle.js";

// Creates real roots, a real catalog, and a lifecycle whose startup behavior can be injected.
export async function safetyFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "nodeforge-admission-"));
  const root = join(directory, "source");
  await mkdir(root);
  const catalogPath = join(directory, "global", "projects.json");
  let starts = 0;
  const lifecycle = await createProjectLifecycle({
    catalogPath, logger: { error() {} },
    // Enforces membership-before-startup independently of the lifecycle implementation.
    async startRuntime(input) {
      starts++;
      const entries = JSON.parse(await readFile(catalogPath, "utf8"));
      assert(entries.some((entry) => entry.root === input.projectRoot && entry.projectId === input.projectId));
      if (options.startRuntime) await options.startRuntime(input);
      return { projectId: input.projectId, async close() {} };
    },
    ...options.lifecycle
  });
  t.after(async () => { await lifecycle.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, root, catalogPath, lifecycle, starts: () => starts,
    membership: async () => JSON.parse(await readFile(catalogPath, "utf8")) };
}
