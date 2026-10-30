// Exercises the production role tool registries against counted File Service and immutable Git
// reads, proving cache reuse across search and read tools without weakening authorization,
// watcher freshness, worktree isolation or verification-environment provenance.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodeCacheService } from "../../src/modules/context/code-cache-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createSprintLeaderForgeTools } from "../../src/tools/roles/sprint-leader-forge-tools.js";
import { blockerRecoveryTools } from "../../src/modules/supervisor/blocker/blocker-recovery-tools.js";
import { createReviewerForgeTools } from "../../src/modules/supervisor/review/reviewer-forge-tools.js";
import { createCommittedReviewSource } from "../../src/modules/supervisor/review/reviewer-committed-source.js";
import { createReviewerCodeCache } from "../../src/modules/supervisor/review/reviewer-code-cache.js";

// Counts actual source reads in an isolated project while leaving all role and path checks real.
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-agent-cache-"));
  let reads = 0;
  try {
    await mkdir(join(root, "backend"));
    await writeFile(join(root, "backend/example.js"), "// needle first\nexport const value = 1;\n");
    const service = createFileService({ projectRoot: root });
    const files = { ...service, readForIndex: async (input) => { reads += 1; return service.readForIndex(input); } };
    const events = [];
    const cache = createCodeCacheService({ projectId: root, fileService: files, logger: (entry) => events.push(entry) });
    try { await run({ root, files, cache, events, reads: () => reads }); }
    finally { cache.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}

// Search warms source once, subsequent windows hit it, and watcher refresh changes delivered bytes.
test("Sprint Leader shares CodeCacheService across search_text, read_file and read_lines", async () => fixture(async ({ root, files, cache, events, reads }) => {
  const dependencies = { projectRoot: root, fileService: files, codeCache: cache,
    profile: { agent_id: "SL", role: "sprint_leader", provider: "codex" }, correlationId: "CACHE-SL" };
  const tools = createSprintLeaderForgeTools(dependencies).registry;
  assert.match((await tools.search_text.execute({ pattern: "needle", paths: ["backend"], flags: ["-n"] })).stdout, /needle first/);
  assert.equal((await tools.read_file.execute({ path: "backend/example.js", offset: 1, limit: 1 })).cache.status, "hit");
  assert.match((await tools.read_lines.execute({ path: "backend/example.js", start_line: 2, end_line: 2 })).stdout, /value = 1/);
  assert.equal(reads(), 1);
  // A new planning request must reuse the same project cache rather than starting a private copy.
  const next = createSprintLeaderForgeTools({ ...dependencies, correlationId: "CACHE-SL-2" }).registry;
  assert.equal((await next.read_file.execute({ path: "backend/example.js", offset: 2, limit: 1 })).cache.status, "hit");
  assert.equal(reads(), 1);
  await writeFile(join(root, "backend/example.js"), "// needle changed\nexport const value = 2;\n");
  assert.equal(await cache.refreshChanged({ path: "backend/example.js" }), "refreshed");
  const refreshed = await next.read_lines.execute({ path: "backend/example.js", start_line: 2, end_line: 2 });
  assert.match(refreshed.stdout, /value = 2/);
  assert.equal(reads(), 3);
  assert.ok(events.some((entry) => entry.event_name === "code_cache.read" && entry.payload.cache_status === "hit"));
}));

// SL and AM can share content but a cache hit never substitutes for the current role's path check.
test("blocker SL and AM reuse project cache and reject a path replaced by a symlink", async () => fixture(async ({ root, files, cache, reads }) => {
  for (const role of ["sprint_leader", "architecture_manager"]) {
    const { registry } = blockerRecoveryTools({ fileService: files, codeCache: cache, projectRoot: root,
      profile: { agent_id: role, role }, task_id: "T-CACHE", correlation_id: `CACHE-${role}` });
    const result = await registry.read_file.execute({ path: "backend/example.js", offset: 1, limit: 1 });
    assert.equal(result.cache.status, role === "sprint_leader" ? "miss" : "hit");
    await registry.read_lines.execute({ path: "backend/example.js", start_line: 2, end_line: 2 });
    await registry.search_text.execute({ pattern: "needle", paths: ["backend"], flags: ["-n"] });
  }
  assert.equal(reads(), 1);
  await rm(join(root, "backend/example.js"));
  await symlink("../outside.js", join(root, "backend/example.js"));
  const { registry } = blockerRecoveryTools({ fileService: files, codeCache: cache, projectRoot: root,
    profile: { agent_id: "SL", role: "sprint_leader" }, task_id: "T-CACHE", correlation_id: "CACHE-REJECT" });
  await assert.rejects(registry.read_file.execute({ path: "backend/example.js", offset: 1, limit: 1 }), { code: "FILE_ROLE_FORBIDDEN" });
  const planning = createSprintLeaderForgeTools({ fileService: files, codeCache: cache, projectRoot: root,
    profile: { agent_id: "SL", role: "sprint_leader" }, correlationId: "CACHE-REJECT-SL" });
  await assert.rejects(planning.registry.read_file.execute({ path: "backend/example.js", offset: 1, limit: 1 }), { code: "FILE_ROLE_FORBIDDEN" });
  assert.equal(reads(), 1);
}));

// A worktree without the shared root cache gets a real cache bound to its own File Service.
test("blocker fallback caches its selected source rather than rereading it for every window", async () => fixture(async ({ root, files, reads }) => {
  const { registry } = blockerRecoveryTools({ fileService: files, projectRoot: root,
    profile: { agent_id: "AM", role: "architecture_manager" }, task_id: "T-WORKTREE", correlation_id: "CACHE-WORKTREE" });
  assert.equal((await registry.read_file.execute({ path: "backend/example.js", offset: 1, limit: 1 })).cache.status, "miss");
  assert.equal((await registry.read_file.execute({ path: "backend/example.js", offset: 2, limit: 1 })).cache.status, "hit");
  await registry.read_lines.execute({ path: "backend/example.js", start_line: 1, end_line: 2 });
  assert.equal(reads(), 1);
}));

// Uses the production Git source adapter so counts include the previously repeated ls-tree/show pair.
test("Reviewer searches and evidence binding reuse immutable Git reads without the live cache", async () => {
  const commit = "a".repeat(40);
  const contents = { "backend/example.js": "// needle owned\nexport const value = 1;\n", "backend/caller.js": "// needle caller\n" };
  const calls = [];
  const git = { modeAt: async () => { calls.push("mode"); return "100644"; }, run: async (args) => {
    calls.push(args[0]);
    if (args[0] === "show") return contents[args[1].slice(commit.length + 1)];
    return Object.keys(contents).map((path) => `100644 blob ${"b".repeat(40)}\t${path}\0`).join("");
  } };
  const source = createCommittedReviewSource({ projectRoot: process.cwd(), commit, baseCommit: "b".repeat(40), git });
  const content = contents["backend/example.js"];
  const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const tools = createReviewerForgeTools({ fileService: source, projectRoot: process.cwd(),
    codeCache: { read: () => assert.fail("Reviewer must not use current project bytes") },
    ticketEvidence: { files: [{ path: "backend/example.js", content, sha256 }],
      context: { review_commit_sha: commit, manifest_sha: "manifest" },
      artifact: { artifact_id: "ARTIFACT-1", file_checksums: { "backend/example.js": sha256 } } },
    reviewer: { agent_id: "REVIEWER", role: "reviewer" }, job: { task_id: "T-REVIEW-CACHE", payload: {} } });
  const first = await tools.registry.read_file.execute({ path: "backend/example.js", offset: 1, limit: 1 });
  assert.equal(first.cache.status, "miss");
  await tools.registry.read_lines.execute({ path: "backend/example.js", start_line: 2, end_line: 2 });
  const second = await tools.registry.read_file.execute({ path: "backend/example.js", offset: 2, limit: 1 });
  assert.equal(second.cache.status, "hit");
  assert.equal(calls.filter((call) => call === "mode").length, 1);
  assert.equal(calls.filter((call) => call === "show").length, 1);
  assert.match((await tools.registry.search_text.execute({ pattern: "needle", paths: ["backend"], flags: ["-n"] })).stdout, /needle caller/);
  await tools.registry.read_lines.execute({ path: "backend/caller.js", start_line: 1, end_line: 1 });
  assert.equal(calls.filter((call) => call === "mode").length, 2);
  assert.equal(calls.filter((call) => call === "show").length, 2);
  await assert.rejects(tools.registry.read_file.execute({ path: ".forge/runtime/private.json" }), { code: "FILE_ROLE_FORBIDDEN" });
});

// Different source identities and environment artifacts must never leak cached source into one another.
test("Reviewer caches isolate projects, commits and artifacts and preserve provenance and byte limits", async () => {
  for (const [projectRoot, commit, artifactId, content] of [["/project-one", "a".repeat(40), "ARTIFACT-1", "one"],
    ["/project-two", "a".repeat(40), "ARTIFACT-1", "two"], ["/project-one", "b".repeat(40), "ARTIFACT-1", "three"],
    ["/project-one", "a".repeat(40), "ARTIFACT-2", "four"]]) {
    let reads = 0;
    const source = createReviewerCodeCache({ projectRoot, artifactId, source: { committedReview: true, reviewCommit: commit,
      readForIndex: async () => { reads += 1; return { content, source: "verification_environment" }; } } });
    for (const status of ["miss", "hit"]) {
      const file = await source.readForIndex({ path: "backend/dependency.js" });
      assert.equal(file.content, content);
      assert.equal(file.source, "verification_environment");
      assert.equal(file.cache.status, status);
    }
    await assert.rejects(source.readForIndex({ path: "backend/dependency.js", maxBytes: 1 }), { code: "REVIEW_EVIDENCE_TOO_LARGE" });
    await assert.rejects(source.readForIndex({ path: "../outside" }), { code: "FILE_ROLE_FORBIDDEN" });
    assert.equal(reads, 1);
  }
});
