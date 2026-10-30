// Exercises verification evidence at the persisted blob and Reviewer tool boundaries. Valid
// recorded callers survive live edits/deletions; malformed snapshots fail before archive writes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertVerificationEnvironment, loadVerificationEnvironment, persistVerificationEnvironment, restoreVerificationEnvironment } from "../../src/modules/supervisor/ticket/ticket-verification-environment.js";
import { materializeTicketVerification } from "../../src/modules/supervisor/ticket/ticket-verification-materialization.js";
import { createVerificationReviewSource } from "../../src/modules/supervisor/ticket/ticket-verification-review-source.js";
import { createReviewerForgeTools } from "../../src/modules/supervisor/review/reviewer-forge-tools.js";

// Produces fixture digests with exactly the same byte contract as persisted evidence.
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Focused acceptance checks must restore the final artifact snapshot rather than
// borrowing live dependencies, and corrupt recorded bytes must remain a failure.
test("focused verification restores immutable environment bytes and rejects ownership conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "nf-restore-environment-"));
  try {
    const recorded = environment();
    const binding = await persistVerificationEnvironment(root, recorded);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/caller.js"), "unrelated workspace edit");
    assert.deepEqual(await restoreVerificationEnvironment(root, binding, ["src/ticket.js"]), recorded);
    await assert.rejects(restoreVerificationEnvironment(root, binding, ["src/caller.js"]), { code: "VERIFY_ENVIRONMENT_INVALID" });
    await writeFile(join(root, ".forge/runtime/ticket-verification/environment/blobs", recorded.files[0].sha256), "corrupt evidence");
    await assert.rejects(restoreVerificationEnvironment(root, binding), { code: "VERIFY_ENVIRONMENT_INVALID" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Supplies a consistent manifest and bytes without reading a mutable project dependency.
function environment(path = "src/caller.js") {
  const bytes = Buffer.from("recorded caller\n");
  const manifest = [{ path, sha256: hash(bytes), mode: 0o644 }];
  return { files: [{ ...manifest[0], bytes }], manifest, sha256: hash(JSON.stringify(manifest)) };
}

// Writes a correctly hashed but possibly malformed manifest to prove hashes alone do not
// authorize file paths, entry types, modes or tree structure.
async function storeManifest(root, manifest, raw = JSON.stringify(manifest)) {
  const sha256 = hash(raw);
  const manifest_path = `.forge/runtime/ticket-verification/environment/manifests/${sha256}.json`;
  await mkdir(join(root, ".forge/runtime/ticket-verification/environment/manifests"), { recursive: true });
  await writeFile(join(root, manifest_path), raw);
  return { sha256, manifest_path };
}

test("persisted manifest validation rejects valid-digest unsafe paths, modes and overlapping files", async () => {
  const root = await mkdtemp(join(tmpdir(), "nf-environment-boundary-"));
  try {
    const entry = environment().manifest[0];
    const invalid = [null, {}, [null], ...["", ".", "../escape", "/escape", "C:/escape", "a\\b", "a//b", "a/", "a\nfile", ".git/config", ".forge/blob", ".forge-tmp/file", "node_modules/pkg.js"].map((path) => [{ ...entry, path }]),
      [{ ...entry, mode: 0o777 }], [{ ...entry, sha256: "not-a-checksum" }], [entry, entry],
      [{ ...entry, path: "src" }, entry], [entry, { ...entry, path: "src" }]];
    for (const manifest of invalid) {
      await assert.rejects(loadVerificationEnvironment(root, await storeManifest(root, manifest)), { code: "VERIFY_ENVIRONMENT_INVALID" });
    }
    await assert.rejects(loadVerificationEnvironment(root, await storeManifest(root, null, "{")), { code: "VERIFY_ENVIRONMENT_INVALID" });
    const valid = environment();
    assert.deepEqual(await loadVerificationEnvironment(root, await storeManifest(root, valid.manifest)), valid.manifest);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid bytes and ticket ownership collisions fail before evidence publication or archive creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "nf-environment-preflight-"));
  try {
    const invalid = environment();
    invalid.files[0].bytes = Buffer.from("unrecorded replacement");
    await assert.rejects(persistVerificationEnvironment(root, invalid), { code: "VERIFY_ENVIRONMENT_INVALID" });
    await assert.rejects(readFile(join(root, ".forge/runtime/ticket-verification/environment/blobs", invalid.files[0].sha256)), { code: "ENOENT" });
    for (const ticketPaths of [["src/caller.js"], ["src"], ["src/caller.js/child.js"]]) {
      await assert.rejects(materializeTicketVerification({ projectRoot: root, commitSha: "a".repeat(40), ticketPaths, environment: environment() }), { code: "VERIFY_ENVIRONMENT_INVALID" });
    }
    await assert.rejects(readFile(join(root, ".forge/runtime/ticket-verification/archives")), { code: "ENOENT" });
    const valid = environment();
    assert.doesNotThrow(() => assertVerificationEnvironment(valid, ["src/caller-other.js"]));
    valid.sha256 = "a".repeat(64);
    assert.throws(() => assertVerificationEnvironment(valid), { code: "VERIFY_ENVIRONMENT_INVALID" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Reviewer discovery and reads use recorded caller bytes after live edits and deletions, then reject corrupt evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "nf-review-environment-"));
  try {
    const recorded = environment();
    const binding = await persistVerificationEnvironment(root, recorded);
    const commit = "a".repeat(40);
    const artifact = { artifact_id: "ARTIFACT", file_checksums: {}, environment: binding };
    const source = createVerificationReviewSource({ projectRoot: root, source: { committedReview: true, reviewCommit: commit,
      readForIndex: async () => assert.fail("Recorded dependencies must not fall back to live or committed source") },
    getArtifact: async () => artifact, getTicketPaths: async () => ["src/ticket.js"] });
    const tools = createReviewerForgeTools({ projectRoot: root, fileService: source,
      ticketEvidence: { artifact, paths: ["src/ticket.js"], files: [], context: { review_commit_sha: commit, base_sha: "b".repeat(40) } },
      job: { task_id: "TASK", request_id: "REQUEST", payload: {} }, reviewer: { agent_id: "REVIEWER", provider: "claude" },
      codeCache: { read: async () => assert.fail("Live cache is not snapshot evidence") } });
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/caller.js"), "live secret must not leak\n");
    for (const deleted of [false, true]) {
      if (deleted) await rm(join(root, "src/caller.js"));
      const read = await tools.registry.read_lines.execute({ path: "src/caller.js", start_line: 1, end_line: 1 });
      assert.equal(read.stdout, "recorded caller\n");
      assert.equal(read.review_source.environment.sha256, binding.sha256);
      assert.equal((await tools.registry.list_files.execute({})).stdout, "src/caller.js\n");
      assert.match((await tools.registry.search_text.execute({ pattern: "recorded", paths: ["src"], flags: ["-n"] })).stdout, /src\/caller.js:1:recorded caller/);
    }
    await writeFile(join(root, ".forge/runtime/ticket-verification/environment/blobs", recorded.files[0].sha256), "corrupt evidence");
    await assert.rejects(tools.registry.read_lines.execute({ path: "src/caller.js", start_line: 1, end_line: 1 }), { code: "VERIFY_ENVIRONMENT_INVALID" });
    await assert.rejects(tools.registry.search_text.execute({ pattern: "recorded", paths: ["src"] }), { code: "VERIFY_ENVIRONMENT_INVALID" });
    await assert.rejects(tools.registry.read_lines.execute({ path: "node_modules/live/index.js", start_line: 1, end_line: 1 }), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
