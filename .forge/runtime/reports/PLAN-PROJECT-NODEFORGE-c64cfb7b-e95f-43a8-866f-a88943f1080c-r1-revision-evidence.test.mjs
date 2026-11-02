/**
 * Business purpose: Verifies and materializes the commit-bound source snapshot, manifest digest, and verbatim scoped Git diff for PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c (r1).
 * Technical description: Executes read-only git plumbing commands against base commit 131a628f042a27f0098df3dfb62f03a1a50223b4 and review commit 452c3c353b46c8f0b92841547177a49b46d77383 to verify blob SHA-256 checksums, materialize the commit-bound snapshot under .forge/runtime/, and validate the 5 split Markdown diff files (each <= 250 lines).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const PLAN_ID = "PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c";
export const BASE_SHA = "131a628f042a27f0098df3dfb62f03a1a50223b4";
export const ROUND3_COMMIT_SHA = "ed4144fdd6c299936a6074f62d632a57afbd15cd";
export const REVIEW_COMMIT_SHA = "452c3c353b46c8f0b92841547177a49b46d77383";
export const EXPECTED_TREE_SHA = "89f1468c05c86d280b6e0dc60a1fe25079d25ff9";
export const EXPECTED_MANIFEST_SHA = "sha256:ab16b7dc1dbf31159ec783c18d513a1bae0f856cbea6b49c5eb8892a2e2b1316";

export const SCOPED_FILES = [
  "ui/nextjs/app/coding/page.jsx",
  "ui/nextjs/components/coding-workspace-monitor.jsx",
  "ui/nextjs/lib/coding-workspace-activity.js",
  "ui/nextjs/app/styles/workspace-monitors.css",
  "ui/nextjs/tests/coding-workspace-layout.test.js",
  "ui/nextjs/tests/coding-workspace-layout-browser.test.js",
  "ui/nextjs/tests/coding-agent-panel-registry.test.js",
  "ui/nextjs/tests/conversations-navigation.test.js",
  "backend/src/modules/supervisor/browser/browser-coding-layout-fixture.js",
  "backend/src/modules/supervisor/browser/browser-coding-layout-scenarios.js",
  "backend/tests/unit/browser-coding-layout.test.js"
];

export const PATCH_PART_PATHS = [
  `docs/reports/${PLAN_ID}-r1-scoped-patch.md`,
  `docs/reports/${PLAN_ID}-r1-scoped-patch-part2.md`,
  `docs/reports/${PLAN_ID}-r1-scoped-patch-part3.md`,
  `docs/reports/${PLAN_ID}-r1-scoped-patch-part4.md`,
  `docs/reports/${PLAN_ID}-r1-scoped-patch-part5.md`
];

/**
 * Business purpose: Computes the canonical sha256:<hex> digest of a UTF-8 string or Buffer for manifest verification.
 * Technical description: Uses Node's crypto.createHash("sha256") and prefixes the lowercase hex digest with "sha256:".
 */
function sha256(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/**
 * Business purpose: Runs a Git command inside the repository root and returns its UTF-8 stdout.
 * Technical description: Invokes execFileSync("git", args) with a 10 MB buffer and utf8 encoding.
 */
function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
}

test("verifies commit-bound snapshots and verbatim 5-part scoped diff across all 11 files", () => {
  const parentSha = runGit(["rev-parse", `${REVIEW_COMMIT_SHA}^`]).trim();
  assert.equal(parentSha, ROUND3_COMMIT_SHA);
  const grandParentSha = runGit(["rev-parse", `${ROUND3_COMMIT_SHA}^`]).trim();
  assert.equal(grandParentSha, BASE_SHA);
  const treeSha = runGit(["rev-parse", `${REVIEW_COMMIT_SHA}^{tree}`]).trim();
  assert.equal(treeSha, EXPECTED_TREE_SHA);

  const snapshotRoots = [
    resolve(`.forge/runtime/reports/${PLAN_ID}-r1-snapshot`, REVIEW_COMMIT_SHA),
    resolve(`.forge/runtime/tickets/ticket-verification/${PLAN_ID}/snapshot`, REVIEW_COMMIT_SHA)
  ];

  const fileChecksums = {};
  const diffByFile = new Map();

  for (const relPath of SCOPED_FILES) {
    const committedContent = runGit(["show", `${REVIEW_COMMIT_SHA}:${relPath}`]);
    const headContent = runGit(["show", `HEAD:${relPath}`]);
    const workingContent = readFileSync(resolve(relPath), "utf8");
    const digest = sha256(committedContent);
    assert.equal(sha256(headContent), digest, `HEAD blob for ${relPath} must match ${REVIEW_COMMIT_SHA}`);
    assert.equal(sha256(workingContent), digest, `Working tree file ${relPath} must match ${REVIEW_COMMIT_SHA}`);
    fileChecksums[relPath] = digest;

    for (const rootDir of snapshotRoots) {
      const target = resolve(rootDir, relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, committedContent, "utf8");
      assert.equal(sha256(readFileSync(target, "utf8")), digest);
    }

    diffByFile.set(relPath, runGit(["diff", `${BASE_SHA}..${REVIEW_COMMIT_SHA}`, "--", relPath]));
  }

  const canonicalManifestEntries = Object.entries(fileChecksums).sort(([a], [b]) => a.localeCompare(b));
  const manifestSha = sha256(JSON.stringify(canonicalManifestEntries));
  assert.equal(manifestSha, EXPECTED_MANIFEST_SHA);

  let reconstructed = "";
  for (const partPath of PATCH_PART_PATHS) {
    const md = readFileSync(resolve(partPath), "utf8");
    const lineCount = md.split("\n").length - Number(md.endsWith("\n"));
    assert.ok(lineCount <= 250, `${partPath} has ${lineCount} lines, exceeding 250-line limit`);
    const match = /```diff\n([\s\S]*?)\n```/.exec(md);
    assert.ok(match, `Missing diff fence in ${partPath}`);
    reconstructed += `${match[1]}\n`;
  }

  const expectedOrderedDiff =
    diffByFile.get("ui/nextjs/app/coding/page.jsx") +
    diffByFile.get("ui/nextjs/components/coding-workspace-monitor.jsx") +
    diffByFile.get("ui/nextjs/lib/coding-workspace-activity.js") +
    diffByFile.get("ui/nextjs/app/styles/workspace-monitors.css") +
    diffByFile.get("backend/src/modules/supervisor/browser/browser-coding-layout-fixture.js") +
    diffByFile.get("backend/src/modules/supervisor/browser/browser-coding-layout-scenarios.js") +
    diffByFile.get("backend/tests/unit/browser-coding-layout.test.js") +
    diffByFile.get("ui/nextjs/tests/coding-workspace-layout.test.js") +
    diffByFile.get("ui/nextjs/tests/coding-agent-panel-registry.test.js") +
    diffByFile.get("ui/nextjs/tests/conversations-navigation.test.js") +
    diffByFile.get("ui/nextjs/tests/coding-workspace-layout-browser.test.js");

  assert.equal(reconstructed, expectedOrderedDiff, "Concatenated 5-part Markdown patch must equal the verbatim git diff across all 11 scoped files");
});
