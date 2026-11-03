// Business purpose: verifies and materializes commit-bound source snapshots, symbol extraction for .mjs files, verbatim split diffs, and durable verification artifacts for PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792.
// Technical description: re-indexes backend/scripts/*.mjs into .forge/runtime/wc/index.db, materializes commit-bound snapshots for dbeac8ddd6092a5790e4e3f184fcda605407a491 and HEAD, and writes/verifies 5-part Markdown unified diffs, durable verification artifacts, and verification reports (each .md <= 250 lines).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { extractorRegistry } from "../../../backend/src/modules/index/parser/index.js";
import { createFileService } from "../../../backend/src/infrastructure/filesystem/file-service.js";
import { openIndexDatabase } from "../../../backend/src/infrastructure/sqlite/index-database.js";
import { createIncrementalIndexer } from "../../../backend/src/modules/index/incremental-indexer.js";
import { countBudgetLines } from "../../../backend/src/tools/governance/agent-code-conventions.js";

export const PLAN_ID = "PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792";
export const BASE_SHA = "fe0df3f39ef7a203057a88e6722475cad047d6c0";
export const BASE_TREE_SHA = "e5b54a82be4116509639934abe445408d5a85e81";
export const R1_COMMIT_SHA = "dbeac8ddd6092a5790e4e3f184fcda605407a491";
export const LEDGER_COMMIT_ID = `OWNER-CONV-SE-${PLAN_ID}-CORR-HANDOFF-${PLAN_ID}-SE-R2`;

export const R1_SCOPED_FILES = [
  "backend/scripts/control-api-project-runtime.mjs",
  "backend/scripts/start-control-api.mjs",
  "backend/scripts/dev-foreground.mjs",
  "backend/scripts/dev-foreground-view.mjs",
  "backend/tests/unit/control-api-project-runtime.test.js",
  "backend/tests/unit/dev-foreground-view.test.js"
];

export const R2_SCOPED_FILES = [
  ...R1_SCOPED_FILES,
  "backend/src/modules/index/parser/index.js",
  "backend/src/modules/index/incremental-indexer.js",
  "backend/src/modules/index/index-record-writer.js",
  "backend/src/modules/index/code-search.js",
  "backend/src/tools/governance/agent-lifecycle-tools.js",
  "backend/tests/unit/javascript-extractor.test.js"
];

// Business purpose: computes the canonical sha256:<hex> digest of a UTF-8 string or Buffer for manifest verification.
// Technical description: uses Node's crypto.createHash("sha256") and prefixes the lowercase hex digest with "sha256:".
function sha256(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

// Business purpose: runs a read-only Git command inside the repository root and returns its UTF-8 stdout.
// Technical description: invokes execFileSync("git", args) with a 10 MB buffer and utf8 encoding.
function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
}

// Business purpose: splits a multi-line unified diff into a fixed number of Markdown documents that each stay within the 250-line read_file limit.
// Technical description: partitions diff lines evenly across partPaths, wraps each slice in a ```diff fenced block with commit metadata headers, and asserts <= 250 lines per file.
function writeSplitDiffParts({ diffText, partPaths, titlePrefix, baseSha, targetSha, fileList }) {
  const allLines = diffText.replace(/\n$/, "").split("\n");
  const partCount = partPaths.length;
  const chunkSize = Math.ceil(allLines.length / partCount);
  const partMeta = [];
  for (let i = 0; i < partCount; i += 1) {
    const slice = allLines.slice(i * chunkSize, (i + 1) * chunkSize);
    const startLine = i * chunkSize + 1;
    const endLine = i * chunkSize + slice.length;
    const header = [
      `# ${titlePrefix} (Part ${i + 1} of ${partCount}) — ${PLAN_ID} (r1)`,
      "",
      `- **Base Commit SHA**: \`${baseSha}\` (\`tree_sha: ${BASE_TREE_SHA}\`)`,
      `- **Target / Review Commit SHA**: \`${targetSha}\``,
      `- **Source / Ledger Revision (\`commit_id\`)**: \`${LEDGER_COMMIT_ID}\``,
      `- **Diff Line Window**: Lines ${startLine}–${endLine} of ${allLines.length}`,
      `- **Scoped Files Covered (${fileList.length})**: ${fileList.map((f) => `\`${f}\``).join(", ")}`,
      "",
      "```diff",
      slice.join("\n"),
      "```",
      ""
    ].join("\n");
    const targetPath = resolve(partPaths[i]);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, header, "utf8");
    const physicalLines = header.split("\n").length - 1;
    assert.ok(physicalLines <= 250, `${partPaths[i]} has ${physicalLines} lines, exceeding 250-line limit`);
    partMeta.push({
      part: i + 1,
      path: partPaths[i],
      sha256: sha256(header),
      total_lines: physicalLines,
      code_lines: countBudgetLines(header),
      diff_lines: `${startLine}-${endLine}`
    });
  }
  return partMeta;
}

// Business purpose: materializes a commit-bound source snapshot and computes its canonical manifest digest and per-file metadata.
// Technical description: reads each file blob from git show <commitSha>:<path>, writes it to both snapshot roots, and returns file metrics and manifest_sha256.
function materializeCommitSnapshot(commitSha, files) {
  const treeSha = runGit(["rev-parse", `${commitSha}^{tree}`]).trim();
  const parentSha = runGit(["rev-parse", `${commitSha}^`]).trim();
  const snapshotRoots = [
    resolve(`.forge/runtime/reports/${PLAN_ID}-r1-snapshot`, commitSha),
    resolve(`.forge/runtime/tickets/ticket-verification/${PLAN_ID}/snapshot`, commitSha)
  ];
  const fileChecksums = {};
  const fileDetails = {};
  for (const relPath of files) {
    const content = runGit(["show", `${commitSha}:${relPath}`]);
    const digest = sha256(content);
    const totalLines = content.split("\n").length - Number(content.endsWith("\n"));
    const codeLines = countBudgetLines(content);
    fileChecksums[relPath] = digest;
    fileDetails[relPath] = { sha256: digest, total_lines: totalLines, code_lines: codeLines };
    for (const rootDir of snapshotRoots) {
      const target = resolve(rootDir, relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
      assert.equal(sha256(readFileSync(target, "utf8")), digest);
    }
  }
  const canonicalEntries = Object.entries(fileChecksums).sort(([a], [b]) => a.localeCompare(b));
  const manifestSha256 = sha256(JSON.stringify(canonicalEntries));
  return { commitSha, treeSha, parentSha, manifestSha256, fileChecksums, fileDetails, snapshotRoots };
}

// Business purpose: writes governed verification artifact JSON and Markdown files for a pinned commit SHA.
// Technical description: persists ARTIFACT-<commitSha>.json and ARTIFACT-<commitSha>.md under .forge/runtime/tickets/ticket-verification/<PLAN_ID>/artifacts/.
function writeVerificationArtifact({ snapshot, patchMeta, symbolsByPath, roundLabel }) {
  const artifactId = `ARTIFACT-${snapshot.commitSha}`;
  const artifactDir = resolve(`.forge/runtime/tickets/ticket-verification/${PLAN_ID}/artifacts`);
  mkdirSync(artifactDir, { recursive: true });
  const jsonPayload = {
    artifact_id: artifactId,
    ticket_id: PLAN_ID,
    plan_id: PLAN_ID,
    plan_revision: "r1",
    round: roundLabel,
    handoff_id: `HANDOFF-${PLAN_ID}-R1`,
    correction_handoff_id: `CORR-HANDOFF-${PLAN_ID}-SE-R2`,
    ledger_commit_id: LEDGER_COMMIT_ID,
    commit_sha: snapshot.commitSha,
    tree_sha: snapshot.treeSha,
    parent_sha: snapshot.parentSha,
    base_sha: BASE_SHA,
    base_tree_sha: BASE_TREE_SHA,
    manifest_sha256: snapshot.manifestSha256,
    status: "passed",
    ready_for_review: true,
    snapshot_roots: [
      `.forge/runtime/reports/${PLAN_ID}-r1-snapshot/${snapshot.commitSha}`,
      `.forge/runtime/tickets/ticket-verification/${PLAN_ID}/snapshot/${snapshot.commitSha}`
    ],
    scoped_patch_parts: patchMeta.map((p) => p.path),
    verification_reports: [
      `docs/reports/${PLAN_ID}-r1-verification.md`,
      `.forge/runtime/reports/${PLAN_ID}-r1-verification.md`
    ],
    files: snapshot.fileDetails,
    indexed_symbols: Object.fromEntries(
      Object.entries(symbolsByPath).map(([p, syms]) => [p, syms.map((s) => `${s.name} (${s.kind}, L${s.start_line}-${s.end_line})`)])
    )
  };
  const jsonPath = resolve(artifactDir, `${artifactId}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(jsonPayload, null, 2)}\n`, "utf8");

  const fileRows = Object.entries(snapshot.fileDetails)
    .map(([p, info], idx) => `| ${idx + 1} | \`${p}\` | \`${info.sha256}\` | ${info.total_lines} | ${info.code_lines} |`)
    .join("\n");
  const patchRows = patchMeta
    .map((p) => `| ${p.part} | \`${p.path}\` | \`${p.sha256}\` | ${p.total_lines} | ${p.diff_lines} |`)
    .join("\n");
  const mdLines = [
    `# Governed Verification Artifact — \`${artifactId}\` (${roundLabel})`,
    "",
    `- **Artifact ID**: \`${artifactId}\``,
    `- **Plan ID**: \`${PLAN_ID}\` (\`r1\`)`,
    `- **Source / Ledger Revision (\`commit_id\`)**: \`${LEDGER_COMMIT_ID}\``,
    `- **Implementation / Review Commit SHA (\`commit_sha\`)**: \`${snapshot.commitSha}\` (\`tree_sha: ${snapshot.treeSha}\`)`,
    `- **Parent Commit SHA**: \`${snapshot.parentSha}\``,
    `- **Declared Base Commit SHA (\`base_sha\`)**: \`${BASE_SHA}\` (\`base_tree_sha: ${BASE_TREE_SHA}\`)`,
    `- **Canonical Manifest Digest (\`manifest_sha256\`)**: \`${snapshot.manifestSha256}\``,
    `- **Snapshot Root A**: \`.forge/runtime/reports/${PLAN_ID}-r1-snapshot/${snapshot.commitSha}/\``,
    `- **Snapshot Root B**: \`.forge/runtime/tickets/ticket-verification/${PLAN_ID}/snapshot/${snapshot.commitSha}/\``,
    "",
    "## 1. Per-File SHA-256 Checksum & Line Count Manifest",
    "",
    "| # | File Path | `sha256` | `total_lines` | `code_lines` |",
    "| ---: | --- | --- | ---: | ---: |",
    fileRows,
    "",
    "## 2. Verbatim Split Unified Diff Parts (`<= 250` lines each)",
    "",
    "| Part | Path | `sha256` | `total_lines` | Diff Lines |",
    "| ---: | --- | --- | ---: | --- |",
    patchRows,
    ""
  ].join("\n");
  const mdPath = resolve(artifactDir, `${artifactId}.md`);
  writeFileSync(mdPath, mdLines, "utf8");
  assert.ok(mdLines.split("\n").length - 1 <= 250, `${mdPath} exceeds 250 lines`);
  return { jsonPath, jsonSha256: sha256(readFileSync(jsonPath, "utf8")), mdPath, mdSha256: sha256(mdLines) };
}

// Business purpose: writes the consolidated human- and Reviewer-readable verification report to docs/reports/ and .forge/runtime/reports/.
// Technical description: formats commit-bound snapshots, manifest digests, per-file checksums, symbol maps, and split diff tables into <= 250 lines.
function writeVerificationReports({ r1Snapshot, headSnapshot, r1PartMeta, activePartMeta, r1Artifact, headArtifact, symbolsByPath }) {
  const headFileRows = Object.entries(headSnapshot.fileDetails)
    .map(([p, info], idx) => `| ${idx + 1} | \`${p}\` | \`${info.sha256}\` | ${info.total_lines} | ${info.code_lines} |`)
    .join("\n");
  const r1FileRows = Object.entries(r1Snapshot.fileDetails)
    .map(([p, info], idx) => `| ${idx + 1} | \`${p}\` | \`${info.sha256}\` | ${info.total_lines} | ${info.code_lines} |`)
    .join("\n");
  const activePatchRows = activePartMeta
    .map((p) => `| ${p.part} | \`${p.path}\` | \`${p.sha256}\` | ${p.total_lines} | ${p.diff_lines} |`)
    .join("\n");
  const r1PatchRows = r1PartMeta
    .map((p) => `| ${p.part} | \`${p.path}\` | \`${p.sha256}\` | ${p.total_lines} | ${p.diff_lines} |`)
    .join("\n");
  const symbolRows = R1_SCOPED_FILES.map((p) => {
    const syms = (symbolsByPath[p] ?? []).map((s) => `\`${s.name}\` (${s.kind}, L${s.start_line}–${s.end_line})`).join(", ");
    return `- \`${p}\`: ${syms}`;
  }).join("\n");

  const reportMd = [
    `# Verification & Review Snapshot Report — ${PLAN_ID} (r1, Round 2)`,
    "",
    `- **Plan ID**: \`${PLAN_ID}\` (\`r1\`)`,
    `- **Handoff ID**: \`HANDOFF-${PLAN_ID}-R1\` (\`CORR-HANDOFF-${PLAN_ID}-SE-R2\`)`,
    `- **Source / Ledger Revision (\`commit_id\`)**: \`${LEDGER_COMMIT_ID}\``,
    `- **Declared Base Commit SHA (\`base_sha\`)**: \`${BASE_SHA}\` (\`base_tree_sha: ${BASE_TREE_SHA}\`)`,
    `- **Round 1 Commit SHA**: \`${R1_COMMIT_SHA}\` (\`tree_sha: ${r1Snapshot.treeSha}\`, \`manifest_sha256: ${r1Snapshot.manifestSha256}\`)`,
    `- **Round 2 Review Commit SHA (\`HEAD\`)**: \`${headSnapshot.commitSha}\` (\`tree_sha: ${headSnapshot.treeSha}\`, \`manifest_sha256: ${headSnapshot.manifestSha256}\`)`,
    `- **Durable Verification Artifacts**:`,
    `  - \`.forge/runtime/tickets/ticket-verification/${PLAN_ID}/artifacts/ARTIFACT-${headSnapshot.commitSha}.json\` (\`${headArtifact.jsonSha256}\`)`,
    `  - \`.forge/runtime/tickets/ticket-verification/${PLAN_ID}/artifacts/ARTIFACT-${headSnapshot.commitSha}.md\` (\`${headArtifact.mdSha256}\`)`,
    `  - \`.forge/runtime/tickets/ticket-verification/${PLAN_ID}/artifacts/ARTIFACT-${R1_COMMIT_SHA}.json\` (\`${r1Artifact.jsonSha256}\`)`,
    `  - \`.forge/runtime/tickets/ticket-verification/${PLAN_ID}/artifacts/ARTIFACT-${R1_COMMIT_SHA}.md\` (\`${r1Artifact.mdSha256}\`)`,
    `- **Commit-Bound Snapshot Roots**:`,
    `  - Round 2 (\`${headSnapshot.commitSha}\`): \`.forge/runtime/reports/${PLAN_ID}-r1-snapshot/${headSnapshot.commitSha}/\` & \`.forge/runtime/tickets/ticket-verification/${PLAN_ID}/snapshot/${headSnapshot.commitSha}/\``,
    `  - Round 1 (\`${R1_COMMIT_SHA}\`): \`.forge/runtime/reports/${PLAN_ID}-r1-snapshot/${R1_COMMIT_SHA}/\` & \`.forge/runtime/tickets/ticket-verification/${PLAN_ID}/snapshot/${R1_COMMIT_SHA}/\``,
    "",
    "## 1. Indexed Symbol Map for `Read({file_path, symbol})` Across All 6 O1/O2 Files",
    "",
    symbolRows,
    "",
    `## 2. Round 2 Scoped File Manifest (\`${headSnapshot.commitSha}\`, \`manifest_sha256: ${headSnapshot.manifestSha256}\`)`,
    "",
    "| # | Scoped File Path | `sha256` | `total_lines` | `code_lines` |",
    "| ---: | --- | --- | ---: | ---: |",
    headFileRows,
    "",
    `## 3. Round 1 Scoped File Manifest (\`${R1_COMMIT_SHA}\`, \`manifest_sha256: ${r1Snapshot.manifestSha256}\`)`,
    "",
    "| # | Scoped File Path | `sha256` | `total_lines` | `code_lines` |",
    "| ---: | --- | --- | ---: | ---: |",
    r1FileRows,
    "",
    `## 4. Verbatim 5-Part Scoped Unified Diff (\`${BASE_SHA}..${headSnapshot.commitSha}\`, All \`<= 250\` Lines)`,
    "",
    "| Part | Path | `sha256` | `total_lines` | Diff Lines |",
    "| ---: | --- | --- | ---: | --- |",
    activePatchRows,
    "",
    `## 5. Verbatim 4-Part Round 1 Scoped Unified Diff (\`${BASE_SHA}..${R1_COMMIT_SHA}\`, All \`<= 250\` Lines)`,
    "",
    "| Part | Path | `sha256` | `total_lines` | Diff Lines |",
    "| ---: | --- | --- | ---: | --- |",
    r1PatchRows,
    ""
  ].join("\n");

  const docsReportPath = resolve(`docs/reports/${PLAN_ID}-r1-verification.md`);
  const runtimeReportPath = resolve(`.forge/runtime/reports/${PLAN_ID}-r1-verification.md`);
  mkdirSync(dirname(docsReportPath), { recursive: true });
  mkdirSync(dirname(runtimeReportPath), { recursive: true });
  writeFileSync(docsReportPath, reportMd, "utf8");
  writeFileSync(runtimeReportPath, reportMd, "utf8");
  const reportLines = reportMd.split("\n").length - 1;
  assert.ok(reportLines <= 250, `Verification report has ${reportLines} lines, exceeding 250-line limit`);
  return { reportSha256: sha256(reportMd), reportLines };
}

test("reindexes .mjs files, materializes commit-bound snapshots, and verifies 5-part unified diffs", async () => {
  const projectRoot = process.cwd();
  const fileService = createFileService({ projectRoot });
  const scriptFiles = readdirSync("backend/scripts")
    .filter((name) => name.endsWith(".mjs") || name.endsWith(".js"))
    .sort()
    .map((name) => `backend/scripts/${name}`);
  const allIndexedPaths = [...new Set([...scriptFiles, ...R2_SCOPED_FILES])];

  const db = await openIndexDatabase(projectRoot, { runtimeDir: ".forge/runtime/wc" });
  const symbolsByPath = {};
  try {
    const indexer = createIncrementalIndexer({ database: db, projectRoot, registry: extractorRegistry, fileService });
    for (const path of allIndexedPaths) {
      await indexer.handleDetailed({ type: "watcher.file_modified", payload: { path }, force: true });
    }
    for (const path of allIndexedPaths) {
      await indexer.handleDetailed({ type: "watcher.file_modified", payload: { path }, phase: "resolve", force: true });
    }
    for (const path of R2_SCOPED_FILES) {
      const symbols = db.all(
        "SELECT s.name, s.kind, s.start_line, s.end_line, s.summary FROM symbols s JOIN files f ON f.file_id = s.file_id WHERE f.path = ? ORDER BY s.start_line",
        [path]
      );
      assert.ok(symbols.length > 0, `Expected indexed DB symbols for ${path}`);
      symbolsByPath[path] = symbols;
    }
  } finally {
    db.close();
  }

  const r1Snapshot = materializeCommitSnapshot(R1_COMMIT_SHA, R1_SCOPED_FILES);
  assert.equal(r1Snapshot.parentSha, BASE_SHA);

  const headSha = runGit(["rev-parse", "HEAD"]).trim();
  const headSnapshot = headSha === R1_COMMIT_SHA
    ? r1Snapshot
    : materializeCommitSnapshot(headSha, R2_SCOPED_FILES);

  const r1PatchParts = [
    `.forge/runtime/reports/${PLAN_ID}-r1-dbeac8d-scoped-patch.md`,
    `.forge/runtime/reports/${PLAN_ID}-r1-dbeac8d-scoped-patch-part2.md`,
    `.forge/runtime/reports/${PLAN_ID}-r1-dbeac8d-scoped-patch-part3.md`,
    `.forge/runtime/reports/${PLAN_ID}-r1-dbeac8d-scoped-patch-part4.md`
  ];
  let r1FullDiff = "";
  for (const relPath of R1_SCOPED_FILES) {
    r1FullDiff += runGit(["diff", `${BASE_SHA}..${R1_COMMIT_SHA}`, "--", relPath]);
  }
  const r1PartMeta = writeSplitDiffParts({
    diffText: r1FullDiff,
    partPaths: r1PatchParts,
    titlePrefix: "Round 1 Scoped Unified Git Diff",
    baseSha: BASE_SHA,
    targetSha: R1_COMMIT_SHA,
    fileList: R1_SCOPED_FILES
  });

  const activePatchParts = [
    `docs/reports/${PLAN_ID}-r1-scoped-patch.md`,
    `docs/reports/${PLAN_ID}-r1-scoped-patch-part2.md`,
    `docs/reports/${PLAN_ID}-r1-scoped-patch-part3.md`,
    `docs/reports/${PLAN_ID}-r1-scoped-patch-part4.md`,
    `docs/reports/${PLAN_ID}-r1-scoped-patch-part5.md`
  ];
  let activeFullDiff = "";
  for (const relPath of R2_SCOPED_FILES) {
    activeFullDiff += headSha === R1_COMMIT_SHA
      ? runGit(["diff", BASE_SHA, "--", relPath])
      : runGit(["diff", `${BASE_SHA}..${headSha}`, "--", relPath]);
  }
  const activePartMeta = writeSplitDiffParts({
    diffText: activeFullDiff,
    partPaths: activePatchParts,
    titlePrefix: "Scoped Unified Git Diff",
    baseSha: BASE_SHA,
    targetSha: headSha,
    fileList: R2_SCOPED_FILES
  });

  let reconstructed = "";
  for (const partPath of activePatchParts) {
    const md = readFileSync(resolve(partPath), "utf8");
    const match = /```diff\n([\s\S]*?)\n```/.exec(md);
    assert.ok(match, `Missing diff fence in ${partPath}`);
    reconstructed += `${match[1]}\n`;
  }
  assert.equal(reconstructed, activeFullDiff, "Concatenated 5-part Markdown patch must equal the verbatim git diff across all scoped files");

  const r1Artifact = writeVerificationArtifact({ snapshot: r1Snapshot, patchMeta: r1PartMeta, symbolsByPath, roundLabel: "Round 1" });
  const headArtifact = writeVerificationArtifact({ snapshot: headSnapshot, patchMeta: activePartMeta, symbolsByPath, roundLabel: "Round 2" });
  const reportInfo = writeVerificationReports({ r1Snapshot, headSnapshot, r1PartMeta, activePartMeta, r1Artifact, headArtifact, symbolsByPath });

  writeFileSync(
    `.forge/runtime/reports/${PLAN_ID}-r1-git-meta.json`,
    JSON.stringify({ baseSha: BASE_SHA, r1Snapshot, headSnapshot, r1PartMeta, activePartMeta, r1Artifact, headArtifact, reportInfo, symbolsByPath }, null, 2),
    "utf8"
  );
});
