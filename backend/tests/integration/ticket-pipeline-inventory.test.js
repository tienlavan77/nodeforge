// Proves legacy ticket inventory classifies worktree commits without creating evidence or claims.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketPipelineInventory } from "../../src/modules/supervisor/ticket-pipeline-inventory.js";

const execFile = promisify(execFileCallback);
const hash = (value) => createHash("sha256").update(value).digest("hex");

// Creates only disposable Git and runtime records for inventory assertions.
async function git(root, ...args) { return (await execFile("git", ["-C", root, ...args])).stdout.trim(); }

// Distinguishes clean migration candidates from pre-context commits and stale contexts.
test("ticket inventory is read-only and conservatively classifies legacy activity", async () => {
  const temp = await mkdtemp(join(tmpdir(), "nodeforge-pipeline-inventory-"));
  const root = join(temp, "project");
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, ".gitignore"), ".forge/\n");
    await writeFile(join(root, "README.md"), "Baseline\n");
    await git(root, "init");
    await git(root, "config", "user.email", "test@example.invalid");
    await git(root, "config", "user.name", "NodeForge Test");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "Baseline");
    const base = await git(root, "rev-parse", "HEAD");
    const treeRoot = join(root, ".forge/worktrees/tickets");
    await mkdir(treeRoot, { recursive: true });
    const a = join(treeRoot, "TICKET-A");
    const b = join(treeRoot, "TICKET-B");
    await git(root, "worktree", "add", "-b", "task/TICKET-A", a, base);
    await git(root, "worktree", "add", "-b", "task/TICKET-B", b, base);
    await writeFile(join(b, "README.md"), "Legacy commit\n");
    await git(b, "add", "README.md");
    await git(b, "commit", "-m", "Pre-context ticket");
    const files = createFileService({ projectRoot: root });
    for (const taskId of ["TICKET-A", "TICKET-B"]) await files.atomicWrite({ path: `.forge/runtime/ticket-workspaces/${taskId}.json`, content: JSON.stringify({ task_id: taskId, path: join(treeRoot, taskId), base_commit: base }), replace: true });
    await files.atomicWrite({ path: `.forge/runtime/agent-checkpoints/TICKET-B.json`, content: JSON.stringify({ task_id: "TICKET-B", status: "completed" }), replace: true });
    await files.atomicWrite({ path: `.forge/runtime/reviewer-checkpoints/TICKET-B.json`, content: JSON.stringify({ task_id: "TICKET-B", review_only: true }), replace: true });
    await files.atomicWrite({ path: `.forge/runtime/ticket-execution-contexts/${hash("PROJECT-TEST")}/TICKET-C.json`, content: JSON.stringify({ task_id: "TICKET-C", project_id: "PROJECT-TEST", state: "verified" }), replace: true });
    const inventory = createTicketPipelineInventory({ projectRoot: root, projectId: "PROJECT-TEST", fileService: files });
    const before = await readFile(join(root, "README.md"), "utf8");
    const result = await inventory.inspect();
    assert.deepEqual(result.tickets.map(({ task_id, classification }) => [task_id, classification]), [["TICKET-A", "migratable"], ["TICKET-B", "human-review-required"], ["TICKET-C", "stale"]]);
    assert.equal(result.tickets[1].review_only, true);
    assert.equal(await readFile(join(root, "README.md"), "utf8"), before);
    assert.equal(await git(root, "rev-parse", "HEAD"), base);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
