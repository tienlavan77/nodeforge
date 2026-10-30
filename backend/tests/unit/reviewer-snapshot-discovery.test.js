// Verifies that Reviewer reads, filename discovery and text search use the same immutable revision,
// including callers outside the ticket diff, without touching live caches or dependency installations.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createReviewerForgeTools } from "../../src/modules/supervisor/review/reviewer-forge-tools.js";
import { createCommittedReviewSource } from "../../src/modules/supervisor/review/reviewer-committed-source.js";

// Pins synthetic reviewed source independently of the real repository's mutable HEAD.
const commit = "a".repeat(40);
// Gives baseline comparisons a different immutable identity without creating a fixture commit.
const base = "b".repeat(40);

// Supplies pinned blobs independently of the mutable cache to expose any accidental live fallback.
function fixture() {
  const contents = new Map([["backend/target.js", "const target = 1;\n"], ["backend/caller.js", "needle committed caller\n"],
    ["docs/guide.md", "needle committed docs\n"], ["backend/secrets/fixture.js", "needle PRIVATE\n"]]);
  const reads = [];
  const source = { committedReview: true, reviewCommit: commit,
    listFiles: async () => [...contents.keys()], listDirectories: async () => ["backend", "backend/secrets", "docs"],
    readForIndex: async ({ path }) => {
      reads.push(path);
      const content = contents.get(path);
      if (content === undefined) throw Object.assign(new Error("Absent from review snapshot"), { code: "ENOENT" });
      return { path, content, sha256: `sha256:${createHash("sha256").update(content).digest("hex")}` };
    } };
  const content = contents.get("backend/target.js");
  const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const evidence = { files: [{ path: "backend/target.js", content, sha256 }], paths: ["backend/target.js"],
    artifact: { artifact_id: "ARTIFACT", file_checksums: { "backend/target.js": sha256 } },
    context: { review_commit_sha: commit, base_sha: base, manifest_sha: "manifest" } };
  const tools = createReviewerForgeTools({ fileService: source, projectRoot: process.cwd(), ticketEvidence: evidence,
    codeCache: { read: async () => assert.fail("Live cache must not supply snapshot evidence") },
    gitService: { status: () => assert.fail("Live status is not snapshot evidence"), diffWorkingTree: () => assert.fail("Live diff is not snapshot evidence") },
    job: { task_id: "TASK", request_id: "REQUEST", payload: {} }, reviewer: { agent_id: "REVIEWER", provider: "claude" } });
  return { tools, source, reads, contents };
}

test("read_file and read_lines outside the diff carry pinned source provenance", async () => {
  const { tools, contents } = fixture();
  const read = await tools.registry.read_file.execute({ path: "backend/caller.js", offset: 1, limit: 1 });
  assert.equal(read.content, "needle committed caller");
  assert.equal(read.review_source.commit_sha, commit);
  assert.equal(read.review_evidence.commit_sha, commit);
  assert.equal(read.review_evidence.sha256, `sha256:${createHash("sha256").update(contents.get("backend/caller.js")).digest("hex")}`);
  assert.equal((await tools.registry.read_lines.execute({ path: "backend/caller.js", start_line: 1, end_line: 1 })).stdout, "needle committed caller\n");
  assert.equal(tools.registry.git_status, undefined);
  assert.equal(tools.registry.git_diff, undefined);
  await assert.rejects(tools.registry.read_file.execute({ path: "backend/live-only.js" }), { code: "ENOENT" });
  await assert.rejects(tools.registry.read_file.execute({ path: "node_modules/package/index.js" }), { code: "ENOENT" });
});

test("snapshot tree, listing and search agree and never use working-tree content", async () => {
  const { tools, reads } = fixture();
  const tree = await tools.registry.search_tree.execute({ path: "." });
  assert.ok(tree.entries.some((entry) => entry.path === "backend/caller.js"));
  assert.ok(tree.entries.every((entry) => !entry.path.includes("secrets")));
  const listed = await tools.registry.list_files.execute({ flags: ["--type=js", "--sort=path"] });
  assert.match(listed.stdout, /backend\/caller.js/);
  assert.doesNotMatch(listed.stdout, /docs|secrets|live-only/);
  const combined = await tools.registry.list_files.execute({ flags: ["--type=js", "--type=md"] });
  assert.match(combined.stdout, /backend\/caller.js/);
  assert.match(combined.stdout, /docs\/guide.md/);
  const matches = await tools.registry.search_text.execute({ pattern: "needle", paths: ["backend", "docs"], flags: ["-n"] });
  assert.match(matches.stdout, /backend\/caller.js:1:needle committed caller/);
  assert.match(matches.stdout, /docs\/guide.md:1:needle committed docs/);
  assert.equal(matches.review_source.commit_sha, commit);
  assert.ok(reads.every((path) => !path.includes("secrets")));
  await assert.rejects(tools.registry.search_text.execute({ pattern: "needle", paths: ["backend"], flags: ["--follow"] }), { code: "REVIEW_SNAPSHOT_INPUT_INVALID" });
});

test("snapshot discovery rejects wrong revisions and strips protected and non-regular committed entries", async () => {
  const { source } = fixture();
  assert.throws(() => createReviewerForgeTools({ fileService: source, projectRoot: process.cwd(),
    ticketEvidence: { files: [], context: { review_commit_sha: base } }, job: { payload: {} }, reviewer: { agent_id: "REVIEWER" } }), { code: "REVIEW_REVISION_INVALID" });
  const entries = ["100644 blob abc\tbackend/caller.js", "120000 blob abc\tbackend/link.js", "160000 commit abc\tbackend/submodule",
    "100644 blob abc\tbackend/secrets/fixture.js", "100644 blob abc\t.env", "100644 blob abc\tnode_modules/package/index.js"];
  const pinned = createCommittedReviewSource({ projectRoot: process.cwd(), commit, baseCommit: base,
    git: { run: async (args) => { assert.deepEqual(args, ["ls-tree", "-r", "-z", "--full-tree", commit]); return `${entries.join("\0")}\0`; } } });
  assert.deepEqual(await pinned.listFiles(), ["backend/caller.js"]);
  assert.deepEqual(await pinned.listDirectories(), ["backend"]);
});
