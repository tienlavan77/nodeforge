// Verifies archived ticket tests receive an empty runtime parent without inheriting live project state.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTicketRootGit } from "../../src/modules/supervisor/ticket/ticket-root-git.js";
import { materializeTicketArchive } from "../../src/modules/supervisor/ticket/ticket-archive-materialization.js";

test("archive supports cwd-relative isolated runtime fixtures and cleans them up without copying live data", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-runtime-"));
  let archive;
  try {
    const git = createTicketRootGit({ projectRoot: root });
    await git.run(["init"]);
    await git.run(["config", "user.name", "Fixture"]);
    await git.run(["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(root, ".gitignore"), ".forge/\n");
    await writeFile(join(root, "source.js"), "export const ready = true;\n");
    await git.run(["add", "."]);
    await git.run(["-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"]);
    await mkdir(join(root, ".forge/runtime"), { recursive: true });
    await writeFile(join(root, ".forge/runtime/live-private-state.json"), "live state");
    archive = await materializeTicketArchive({ projectRoot: root, commitSha: (await git.run(["rev-parse", "HEAD"])).trim() });
    assert.deepEqual(await readdir(join(archive.path, ".forge/runtime")), []);
    const fixtureRoot = await mkdtemp(join(archive.path, ".forge/runtime/architecture-choices-test-"));
    await writeFile(join(fixtureRoot, "index.json"), "fixture state");
    await archive.cleanup();
    await assert.rejects(() => readdir(archive.path), { code: "ENOENT" });
    assert((await readdir(join(root, ".forge/runtime"))).includes("live-private-state.json"));
  } finally { await archive?.cleanup(); await rm(root, { recursive: true, force: true }); }
});
