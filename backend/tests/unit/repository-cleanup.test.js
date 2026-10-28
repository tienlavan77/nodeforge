// Verifies repository governance cleanup by confirming that root and backend debris paths, stray title directory trees, and temporary lint logs are removed from the repository, that the duplicate conversation content analysis architecture plan is consolidated into a single byte-identical archived document under docs/archive/, and that the tool-lab marker file backend/tool-lab-target.txt remains intact at its canonical location with its expected baseline content and SHA-256 digest so tool-lab tests continue to pass without disruption.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const EXPECTED_PLAN_SHA256 = "19778e0000223ead3a7ce2ba9a1799b88b0a4fb2e69b346a976d3437744a0f85";
const EXPECTED_TOOL_LAB_SHA256 = "f62f677506d608e2adfcd8183c8881cde3ba04c979529722b37ba33ade5f5c84";
const EXPECTED_TOOL_LAB_CONTENT = "status-smoke-renamed\nwatcher-header-agent-status: PID | RAM | %CPU | Uptime\n";

// Checks whether a project-relative path exists on disk within the repository root so tests can assert removed debris or retained artifacts.
async function pathExists(relativePath) {
  try {
    await access(resolve(REPO_ROOT, relativePath));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// Computes the lowercase hexadecimal SHA-256 digest of a UTF-8 string or Buffer to verify exact byte-level document and marker integrity.
function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

test("AC-1: approved debris files and stray title directory tree do not exist in the repository", async () => {
  const removedPaths = [
    "x",
    "backend/x",
    "title",
    "title/objective",
    "title/objective/acceptance_criteria",
    "docs/giai-doan-3/code-cache-lint.log"
  ];

  for (const relativePath of removedPaths) {
    assert.equal(
      await pathExists(relativePath),
      false,
      `Expected debris path '${relativePath}' to be removed from repository`
    );
  }
});

test("AC-2: duplicate conversation-content-analysis-architecture-plan.md is consolidated into a single archive location", async () => {
  const candidateLocations = [
    "docs/conversation-content-analysis-architecture-plan.md",
    "workflows/conversation-content-analysis-architecture-plan.md",
    "docs/archive/conversation-content-analysis-architecture-plan.md",
    "workflows/archive/conversation-content-analysis-architecture-plan.md"
  ];

  const existingLocations = [];
  for (const relativePath of candidateLocations) {
    if (await pathExists(relativePath)) {
      existingLocations.push(relativePath);
    }
  }

  assert.deepEqual(existingLocations, ["docs/archive/conversation-content-analysis-architecture-plan.md"]);

  const archivedPath = resolve(REPO_ROOT, existingLocations[0]);
  const archivedContent = await readFile(archivedPath);
  assert.equal(archivedContent.byteLength, 14652);
  assert.equal(sha256Hex(archivedContent), EXPECTED_PLAN_SHA256);
});

test("AC-3: backend/tool-lab-target.txt is preserved at its exact location and content for tool-lab tests", async () => {
  const markerRelPath = "backend/tool-lab-target.txt";
  assert.equal(await pathExists(markerRelPath), true);

  const markerPath = resolve(REPO_ROOT, markerRelPath);
  const markerStat = await stat(markerPath);
  assert.equal(markerStat.isFile(), true);

  const markerContent = await readFile(markerPath, "utf8");
  assert.equal(markerContent, EXPECTED_TOOL_LAB_CONTENT);
  assert.equal(sha256Hex(markerContent), EXPECTED_TOOL_LAB_SHA256);
});
