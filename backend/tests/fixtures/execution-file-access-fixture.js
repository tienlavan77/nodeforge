/** Supplies real project directories and Node-issued contexts for filesystem
 * race and cache authorization tests. Fixtures distinguish project-wide Coder
 * permissions from the scoped read grants retained for Reviewer. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { issueExecutionFileAccess } from "../../src/tools/execution-file-access.js";

// Identifies synthetic Node policy provenance for test contexts without borrowing production state.
const policyIdentity = { id: "race-policy", revision: "1", sha256: `sha256:${"c".repeat(64)}` };

// Computes the sha256 checksum format expected by write_diff and edit_diff preflight checks.
export const sha256 = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

// Builds a real temporary project root and an outside directory for symlink-escape race targets.
export async function createRaceWorkspace(t) {
  const base = await mkdtemp(join(tmpdir(), "nf-race-boundary-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  const outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  const files = {
    "backend/target.js": "// Summary: Target module for safe edits.\nexport const target = 1;\n",
    "backend/caller.js": "// Summary: Caller module outside manifest.\nexport const caller = 'SAFE_CALLER';\n",
    "backend/sub/leaf.js": "// Summary: Nested module for ancestor swap.\nexport const leaf = 'SAFE_LEAF';\n",
    "docs/guide.md": "# Guide\nSafe guide content.\n",
    "ui/panel.js": "// Summary: UI module outside narrowed grant.\nexport const ui = 'UI_ONLY';\n",
    ".env": "SECRET_TOKEN=TOP_SECRET_ENV\n",
    "AGENTS.md": "# Governance\nProtected governance instructions.\n"
  };
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content, "utf8");
  }
  await writeFile(join(outside, "external.js"), "// OUTSIDE_SECRET_PAYLOAD\n", "utf8");
  await writeFile(join(outside, "leaf.js"), "// OUTSIDE_ANCESTOR_SWAP_PAYLOAD\n", "utf8");
  return { root, outside, files };
}

// Issues a bound v2 Coder context for the given project root and mutable manifest.
export function createCoderContext(root, {
  role = "coder",
  allowedFiles = ["backend/target.js"],
  createPrefixes = ["backend/new"],
  readPaths = ["package.json"],
  readPrefixes = ["backend", "docs"],
  authorizeCurrent = () => true,
  capabilities = ["read_file", "read_lines", "write_diff", "edit_diff", "list_files", "search_text", "search_tree", "search_code", "read_code", "select_code_graph_candidates"]
} = {}) {
  const checksums = Object.fromEntries(allowedFiles.map((path) => [path, null]));
  const context = {
    task_id: "TASK-RACE",
    execution_id: "EXEC-RACE",
    project_root: root,
    agent_identity: { agent_id: "CODER-1", role, provider: "claude" },
    capabilities,
    allowed_file_paths: allowedFiles,
    allowed_prefixes: [],
    authorized_create_prefixes: createPrefixes,
    changed_paths: [],
    execution_context: { approved_baseline: { file_checksums: checksums, authorized_create_prefixes: createPrefixes, mutable_file_budget: 4 } }
  };
  context.file_access_policy = issueExecutionFileAccess({ context, readPaths, readPrefixes, policyIdentity, authorizeCurrent });
  context.file_access_version = 2;
  return context;
}

