// Exercises real file listing, cached text search and bounded reads through a separately issued
// read grant, ensuring forbidden names and snippets are rejected before touching the shared cache.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { issueExecutionFileAccess } from "../../src/tools/execution-file-access.js";
import { createRgFilesTool } from "../../src/tools/discovery/rg-files.js";
import { createRgSearchTool } from "../../src/tools/discovery/rg-search.js";
import { createSedLinesTool } from "../../src/tools/discovery/sed-lines.js";
import { createReadFileTool } from "../../src/tools/governance/agent-lifecycle-tools.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { engineeringToolImplementations } from "../../src/tools/engineering-tool-implementations.js";
import { buildToolTicketPrompt, buildCodexTicketPrompt } from "../../src/modules/supervisor/nodeforge-task-prompts.js";

test("tree/list/search/read share safe discovery scope without using write prefixes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "execution-read-scope-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const contents = { "backend/target.js": "target\n", "backend/caller.js": "needle caller\n", "docs/guide.md": "needle docs\n",
    "backend/secrets/fixture.js": "needle PRIVATE\n", "backend/private.key": "needle PRIVATE\n", "ui/outside.js": "needle OUTSIDE\n",
    "backend/aliased\nbackend/ghost.js": "needle ALIAS\n" };
  for (const [path, content] of Object.entries(contents)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const issued = { task_id: "TASK", execution_id: "EXEC", project_root: root, agent_identity: { agent_id: "REVIEWER", role: "reviewer" },
    capabilities: ["list_files", "search_text", "read_lines", "read_file"], allowed_file_paths: ["backend/target.js"], allowed_prefixes: [] };
  let active = true;
  issued.file_access_policy = issueExecutionFileAccess({ context: issued, readPrefixes: ["backend", "docs"],
    policyIdentity: { id: "test-policy", revision: "1", sha256: `sha256:${"a".repeat(64)}` }, authorizeCurrent: () => active });
  issued.file_access_version = 2;
  const files = createFileService({ projectRoot: root });
  const reads = [];
  const cache = { read: async ({ path }) => { reads.push(path); return files.readForIndex({ path }); } };
  const logger = { emit() {} };
  const listed = await createRgFilesTool({ projectRoot: root, toolName: "list_files", logger }).execute({}, issued);
  assert.match(listed.stdout, /backend\/caller.js/);
  assert.match(listed.stdout, /docs\/guide.md/);
  assert.doesNotMatch(listed.stdout, /secrets|private|ui\/|aliased|ghost/);
  const searched = await createRgSearchTool({ projectRoot: root, codeCache: cache, toolName: "search_text", logger })
    .execute({ pattern: "needle", paths: ["backend", "docs"], flags: ["-n"] }, issued);
  assert.match(searched.stdout, /backend\/caller.js:1:needle caller/);
  assert.match(searched.stdout, /docs\/guide.md:1:needle docs/);
  assert.doesNotMatch(searched.stdout, /PRIVATE|OUTSIDE|ALIAS/);
  assert.ok(reads.every((path) => !/secrets|private|ui\//.test(path)));
  const tree = engineeringToolImplementations({ fileService: files, projectRoot: root, wrap: (tool) => tool }).search_tree;
  const entries = await tree.execute({ path: "." }, issued);
  assert.ok(entries.entries.some((entry) => entry.path === "backend/caller.js"));
  assert.ok(entries.entries.every((entry) => !/secrets|private|ui(?:\/|$)/.test(entry.path)));
  const lines = createSedLinesTool({ projectRoot: root, fileService: files, codeCache: cache, toolName: "read_lines", logger });
  assert.equal((await lines.execute({ path: "backend/caller.js", start_line: 1, end_line: 1 }, issued)).stdout, "needle caller\n");
  const read = createReadFileTool({ fileService: files, codeCache: cache, projectRoot: root });
  assert.equal((await read.execute({ path: "docs/guide.md" }, issued)).content, "needle docs\n");
  await assert.rejects(read.execute({ path: "ui/outside.js" }, issued), { code: "PATH_FORBIDDEN" });
  active = false;
  const before = reads.length;
  await assert.rejects(read.execute({ path: "docs/guide.md" }, issued), { code: "FILE_ACCESS_POLICY_INVALID" });
  assert.equal(reads.length, before);
});

test("both SDK prompts explain project-wide Coder file access independently of baseline hints", () => {
  for (const buildPrompt of [buildToolTicketPrompt, buildCodexTicketPrompt]) {
    for (const [direct, immutable] of [[true, false], [false, true]]) {
      const prompt = buildPrompt({ id: "TASK", title: "Read caller" }, null, ["backend/target.js"], {}, direct, immutable);
      assert.match(prompt, /project-wide file access/);
      assert.match(prompt, /Coder may read, write, delete and move files/);
      assert.doesNotMatch(prompt, /[Ww]orkflows (?:remain|are always) read-only|Write only these exact paths|within manifest\/create authority/);
      assert.doesNotMatch(prompt, /must not access docs|Read and edit only approved manifest|unless its exact document edit/);
    }
  }
});
