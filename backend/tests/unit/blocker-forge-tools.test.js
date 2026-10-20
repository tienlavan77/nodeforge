// Verifies recovery source comparisons use Node's immutable baseline and preserve the working tree.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { engineeringToolDefinitions } from "../../src/tools/engineering-tool-catalog.js";
import { createBlockerRecoveryAgent } from "../../src/modules/supervisor/blocker-recovery-agent.js";
import { blockerRecoveryTools } from "../../src/modules/supervisor/blocker-recovery-tools.js";

const exec = promisify(execFile);
const digest = (text) => createHash("sha256").update(text).digest("hex");

test("AM compares baseline/current bytes, new and deleted files without modifying Git or contract bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "blocker-baseline-"));
  const git = async (...args) => (await exec("git", ["-C", root, ...args])).stdout;
  try {
    await mkdir(join(root, "backend"));
    await git("init", "--quiet");
    await git("config", "user.name", "Fixture");
    await git("config", "user.email", "fixture@example.test");
    await writeFile(join(root, "backend/source.js"), "baseline\nline two\n");
    await writeFile(join(root, "backend/deleted.js"), "deleted later\n");
    await git("add", ".");
    await git("commit", "--quiet", "-m", "baseline");
    const commit = (await git("rev-parse", "HEAD")).trim();
    await writeFile(join(root, "backend/source.js"), "current\nline two\n");
    await writeFile(join(root, "backend/new.js"), "new file\n");
    await rm(join(root, "backend/deleted.js"));
    const before = await git("status", "--porcelain");
    const evidence = [{ path: "backend/source.js", sha256: digest("baseline\nline two\n"), authority_quote: "Keep the existing contract." }];
    const tools = blockerRecoveryTools({ fileService: createFileService({ projectRoot: root }), projectRoot: root,
      profile: { role: "architecture_manager", agent_id: "AM" }, task_id: "TASK", correlation_id: "CORR",
      job: { request: { execution_context: { base_sha: commit }, ticket: { execution_policy: { contract_evidence: evidence } } } } });
    assert.deepEqual(Object.keys(tools.registry), ["search_tree", "list_files", "search_text", "read_file", "read_lines", "git_status", "git_diff"]);
    for (const definition of tools.definitions) {
      assert.deepEqual(definition.input_schema, engineeringToolDefinitions().find(({ name }) => name === definition.name).input_schema);
    }
    const unbound = blockerRecoveryTools({ fileService: createFileService({ projectRoot: root }), projectRoot: root,
      profile: { role: "architecture_manager", agent_id: "AM" }, task_id: "TASK", correlation_id: "CORR",
      job: { evidence: [{ reference: "backend/source.js:1" }] } });
    await assert.rejects(() => unbound.registry.git_diff.execute({}), /immutable execution baseline/);
    const result = await tools.registry.read_lines.execute({ path: "backend/source.js", start_line: 1, end_line: 1 });
    assert.equal(result.sha256, `sha256:${digest("current\nline two\n")}`);
    const patch = await tools.registry.git_diff.execute({});
    assert.equal(patch.baseline_commit, commit);
    assert.match(patch.stdout, /-baseline/);
    assert.match(patch.stdout, /\+current/);
    await assert.rejects(() => tools.registry.git_diff.execute({ revision: "HEAD" }), /accepts no arguments/);
    await tools.registry.read_file.execute({ path: "backend/new.js" });
    assert.equal((await tools.registry.git_status.execute({})).untracked_files, 1);
    await assert.rejects(() => tools.registry.read_file.execute({ path: "../outside" }));
    await symlink(join(root, "backend/source.js"), join(root, "backend/link.js"));
    await assert.rejects(() => tools.registry.read_file.execute({ path: "backend/link.js" }));
    await rm(join(root, "backend/link.js"));
    assert.equal(await git("status", "--porcelain"), before);
    await git("add", "backend/source.js");
    assert.match((await tools.registry.git_diff.execute({})).stdout, /\+current/);
    await git("commit", "--quiet", "-m", "partial work");
    assert.match((await tools.registry.git_diff.execute({})).stdout, /\+current/);
    assert.equal(evidence[0].sha256, digest("baseline\nline two\n"));
    // Root-only AM research must inspect live changes even when the ticket has no committed review artifact.
    const worker = createBlockerRecoveryAgent({
      agentResolver: { resolveAvailable: () => ({ role: "architecture_manager", agent_id: "AM", provider: "openai", enabled: true, status: "ready" }) },
      agentOccupancy: { claim: async () => ({ claim_id: "CLAIM" }), release: async () => {} },
      resolveTicketWorkspace: async () => ({ root_only: true, path: root, projectRoot: root,
        fileService: createFileService({ projectRoot: root }),
        gitService: { diffPatchFrom: async () => assert.fail("Committed Reviewer adapter must not serve AM live-source reads") } }),
      readFailureEvidence: async () => ({ status: "missing", receipts: [] }),
      gateways: { openaiSdkGateway: { execute: async ({ options }) => {
        const actual = await options.forgeTools.registry.git_diff.execute({});
        assert.equal(actual.baseline_commit, commit);
        assert.match(actual.stdout, /\+current/);
        return { text: JSON.stringify({ action: "resolved" }) };
      } } }
    });
    await worker({ id: "JOB", stage: "architecture_manager", request: { task_id: "TASK", execution_context: { base_sha: commit },
      ticket: { execution_policy: { contract_evidence: evidence } } }, history: [] }, { deadline: Date.now() + 2000 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
