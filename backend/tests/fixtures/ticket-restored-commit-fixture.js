/** Builds an isolated real Git repository and the production ledger/context
 * services so restoration tests prove receipt identity without modifying the
 * project repository, agent checkpoints or runtime database. */
import { execFile as callback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createGitService } from "../../src/infrastructure/git/git-service.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket-change-ledger.js";
import { createTicketRootCommitService } from "../../src/modules/supervisor/ticket-root-commit-service.js";
import { createTicketExecutionContextStore } from "../../src/modules/supervisor/ticket-execution-context.js";

// Converts scoped identities to the same runtime filenames used by production services.
const key = (value) => createHash("sha256").update(value).digest("hex");
const execFile = promisify(callback);

/** Commits one ticket edit, then exposes restartable service factories and
 * diagnostic edit/restore operations with genuine monotonically increasing revisions. */
export async function ticketRestoredCommitFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "forge-restored-commit-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  // Runs Git without a shell and retains exact stdout where source bytes matter.
  const git = async (...args) => (await execFile("git", ["-C", root, ...args])).stdout;
  await git("init", "-q");
  await git("config", "user.name", "Forge Test");
  await git("config", "user.email", "forge-test@localhost");
  await writeFile(join(root, ".gitignore"), ".forge/\n");
  await writeFile(join(root, "a.js"), "baseline\n");
  await writeFile(join(root, "b.js"), "unrelated\n");
  await git("add", ".gitignore", "a.js", "b.js");
  await git("commit", "-qm", "baseline");
  const projectId = "P-RESTORE", taskId = "T-RESTORE", logs = [];
  const files = createFileService({ projectRoot: root });
  const ledger = createTicketChangeLedger({ fileService: files, projectId });
  const executionContexts = createTicketExecutionContextStore({ fileService: files, projectId, projectRoot: root });
  await executionContexts.create({ taskId, supervisorId: "SV", baseSha: (await git("rev-parse", "HEAD")).trim() });
  // Reopens the production Git adapter to simulate a process restart without carrying in-memory proof.
  const service = () => createTicketRootCommitService({ taskId, projectId, projectRoot: root, fileService: files,
    ledger, gitService: createGitService({ projectRoot: root }), projectLogger: (event) => logs.push(event) });
  await ledger.write({ taskId, path: "a.js", before: "baseline\n", after: "ticket\n" });
  const committed = await service().commit("ticket change");
  const initial = await ledger.load(taskId);
  let saved = await executionContexts.syncManifest(taskId, initial);
  saved = await executionContexts.update(taskId, saved.version, { state: "verified", review_commit_sha: committed.sha, verification_artifact_id: "ARTIFACT-OLD" });
  // Models the same diagnostic round trip that previously stranded report_done behind COMMIT_MISSING.
  const restore = async () => {
    await ledger.write({ taskId, path: "a.js", before: "ticket\n", after: "diagnostic\n" });
    await ledger.write({ taskId, path: "a.js", before: "diagnostic\n", after: "ticket\n" });
    await executionContexts.syncManifest(taskId, await ledger.load(taskId));
  };
  const journalPath = (revision) => `.forge/runtime/ticket-root-commits/${key(projectId)}/${key(taskId)}-${revision}.json`;
  const manifestPath = `.forge/runtime/ticket-changes/${key(projectId)}/tickets/${key(taskId)}.json`;
  return { root, git, projectId, taskId, files, ledger, executionContexts, saved, committed, initial, service, restore, logs, journalPath, manifestPath,
    changeLedger: { load: () => ledger.load(taskId), snapshot: () => ledger.snapshot(taskId) } };
}
