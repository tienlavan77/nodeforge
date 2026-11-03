# Scoped Unified Git Diff (Part 6 of 9) — PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792 (r1, Round 3)

- **Base Commit SHA**: `fe0df3f39ef7a203057a88e6722475cad047d6c0` (`tree_sha: e5b54a82be4116509639934abe445408d5a85e81`)
- **Target / Review Commit SHA**: `6f78aa84c7260b5a439d142b116d9121ef67c3d1`
- **Source / Ledger Revision (`commit_id`)**: `OWNER-CONV-SE-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-CORR-HANDOFF-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-SE-R3`
- **Diff Line Window**: Lines 776–930 of 1395

```diff
index f59010b..2761464 100755
--- a/backend/src/modules/index/parser/index.js
+++ b/backend/src/modules/index/parser/index.js
@@ -35,7 +35,7 @@ export function createExtractorRegistry() {
 }
 
 export const extractorRegistry = createExtractorRegistry();
-extractorRegistry.register([".js", ".ts", ".jsx", ".tsx"], extractJavaScript);
+extractorRegistry.register([".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx"], extractJavaScript);
 extractorRegistry.register([".php"], extractPhp);
 extractorRegistry.register([".css"], extractCss);
 extractorRegistry.register([".jsx", ".tsx"], (source) => extractJavaScript(source, { jsxUi: true }));
diff --git a/backend/src/modules/supervisor/review/reviewer-forge-tools.js b/backend/src/modules/supervisor/review/reviewer-forge-tools.js
index cb55dde..2743abc 100644
--- a/backend/src/modules/supervisor/review/reviewer-forge-tools.js
+++ b/backend/src/modules/supervisor/review/reviewer-forge-tools.js
@@ -66,7 +66,7 @@ export function createReviewerForgeTools({ fileService, projectRoot, job, review
     listDirectories: async (input) => filterPaths(await fileService.listDirectories(input))
   };
   const reviewCache = ticketEvidence ? { ...(codeCache ?? {}), read: async ({ path }) => {
-    if (path === ".forge" || path.startsWith(".forge/")) return scopedFiles.readForIndex({ path });
+    if (path === ".forge" || path.startsWith(".forge/")) return codeCache?.read ? codeCache.read({ path }).catch(() => scopedFiles.readForIndex({ path })) : scopedFiles.readForIndex({ path });
     const file = ticketEvidence.files.find((item) => item.path === path);
     if (!file || file.deleted) return snapshot ? scopedFiles.readForIndex({ path }) : codeCache?.read ? codeCache.read({ path }) : scopedFiles.readForIndex({ path });
     const live = await verifiedReviewFile(file, ticketEvidence, fileService, projectRoot);
@@ -92,7 +92,7 @@ export function createReviewerForgeTools({ fileService, projectRoot, job, review
   } };
   const implementations = {
     lookup_schema: createLookupSchemaTool({ role: "reviewer" }),
-    read_file: createReadFileTool({ fileService: scopedFiles, codeCache: { read: (input) => input.path === ".forge" || input.path.startsWith(".forge/") ? scopedFiles.readForIndex(input) : reviewCache?.read ? reviewCache.read(input) : scopedFiles.readForIndex(input) }, projectRoot, ...(snapshot ? { dependencyReader: (input) => scopedFiles.readForIndex(input) } : {}), maxChars: MAX_RESULT_BYTES }),
+    read_file: createReadFileTool({ fileService: scopedFiles, codeCache: { read: (input) => (input.path === ".forge" || input.path.startsWith(".forge/")) ? (codeCache?.read ? codeCache.read(input).catch(() => scopedFiles.readForIndex(input)) : scopedFiles.readForIndex(input)) : reviewCache?.read ? reviewCache.read(input) : scopedFiles.readForIndex(input) }, projectRoot, ...(snapshot ? { dependencyReader: (input) => scopedFiles.readForIndex(input) } : {}), maxChars: MAX_RESULT_BYTES }),
     search_text: createRgSearchTool({ projectRoot, codeCache: searchCache, toolName: "search_text", logger: { emit: terminalAuditLogger(projectLogger) } }),
     ...(!snapshot && gitService?.status && gitService?.diffWorkingTree ? createGitReadTools({ gitService, logger: { emit: terminalAuditLogger(projectLogger) } }) : {}),
     list_files: createRgFilesTool({ projectRoot, toolName: "list_files", logger: { emit: terminalAuditLogger(projectLogger) } }),
diff --git a/backend/src/tools/discovery/agent-file-index-view.js b/backend/src/tools/discovery/agent-file-index-view.js
index d32410e..6e8ae69 100644
--- a/backend/src/tools/discovery/agent-file-index-view.js
+++ b/backend/src/tools/discovery/agent-file-index-view.js
@@ -18,7 +18,7 @@ export function scopedGraph(graph, context) {
     if (typeof path !== "string") return false;
     if (context.agent_identity?.role === "coder") return isAgentPathAllowed(path, context);
     if (context.file_access_version !== undefined || context.file_access_policy !== undefined) return isAgentPathAllowed(path, context);
-    if (context.agent_identity?.role === "architecture_manager" || context.agent_identity?.role === "system_engineer") {
+    if (["architecture_manager", "system_engineer", "reviewer", "sprint_leader"].includes(context.agent_identity?.role)) {
       if (context.agent_identity.role === "system_engineer" && !isAgentPathAllowed(path, context)) return false;
       try { assertRoleFileAccess(context.agent_identity.role, "read", path); return true; }
       catch (error) { if (error.code === "FILE_ROLE_FORBIDDEN") return false; throw error; }
diff --git a/backend/src/tools/governance/agent-lifecycle-tools.js b/backend/src/tools/governance/agent-lifecycle-tools.js
index dcc0a5a..c119d02 100644
--- a/backend/src/tools/governance/agent-lifecycle-tools.js
+++ b/backend/src/tools/governance/agent-lifecycle-tools.js
@@ -10,10 +10,9 @@ import { loadAgentContextConventions } from "../../modules/supervisor/agent-cont
 import { scopedGraph } from "../discovery/agent-file-index-view.js";
 import { recordSourceMetadata } from "../discovery/source-metadata-receipts.js";
 import { extractorRegistry } from "../../modules/index/parser/index.js";
-import { hasFileHeaderComment, extractFunctionSignatures, findFunctionDeclarationLine, hasPrecedingComment, extractFileHeaderComment, extractPrecedingCommentBlock, countBudgetLines, validateCommentLanguage, MARKDOWN_LINE_LIMIT, CODE_LINE_LIMIT, resolveFileLineLimit } from "./agent-code-conventions.js";
+import { hasFileHeaderComment, extractFunctionSignatures, findFunctionDeclarationLine, hasPrecedingComment, extractFileHeaderComment, extractPrecedingCommentBlock, countBudgetLines, validateCommentLanguage, resolveFileLineLimit } from "./agent-code-conventions.js";
 import { discoveryNotice, recordRead, resetExploration } from "../discovery/exploration-state.js";
 const MAX_CONTENT = 200000;
-const WRITE_DIFF_MAX_LINES = 400;
 const DOCUMENT_LINE_LIMIT = 250;
 // safePath - handles safePath operation.
 const safePath = (value, operation = "read", role) => {
@@ -55,7 +54,9 @@ export function createReadFileTool({ fileService, codeCache, projectRoot, depend
     const sha256 = file.sha256 ?? checksum(file.content);
     const sizeBytes = file.size_bytes ?? Buffer.byteLength(file.content);
     const lines = file.content.split("\n");
-    const symbols = codeCache ? file.code_index?.symbols ?? [] : extractorRegistry.extract(path, file.content).symbols;
+    const symbols = codeCache && Array.isArray(file.code_index?.symbols) && file.code_index.symbols.length
+      ? file.code_index.symbols
+      : extractorRegistry.extract(path, file.content).symbols;
     const metadata = { path, sha256, size_bytes: sizeBytes, total_lines: lines.length, code_lines: countBudgetLines(file.content),
       cache: file.cache ?? { status: "bypass", cached_at: null, expires_at: null }, content_sha256: file.content_sha256 ?? sha256,
       indexed_sha256: file.indexed_sha256 ?? null, index_version: file.index_version ?? null,
diff --git a/backend/src/tools/roles/owner-conversation-tools.js b/backend/src/tools/roles/owner-conversation-tools.js
index 607133a..7136873 100644
--- a/backend/src/tools/roles/owner-conversation-tools.js
+++ b/backend/src/tools/roles/owner-conversation-tools.js
@@ -21,7 +21,7 @@ export function createOwnerConversationTools({ role, projectRoot, fileService, c
   const scopedFiles = createRoleFileService({ fileService, role, projectRoot });
   const scopedCache = codeCache && { ...codeCache, read: async ({ path }) => {
     await scopedFiles.assertReadPath(path);
-    if (role === "system_engineer" && /^(?:node_modules|\.forge)(?:\/|$)/.test(path)) return scopedFiles.readForIndex({ path });
+    if (role === "system_engineer" && (/^node_modules(?:\/|$)/.test(path) || (/^\.forge(?:\/|$)/.test(path) && !codeSearch?.fileMetadata?.(path)))) return scopedFiles.readForIndex({ path });
     return codeCache.read({ path });
   } };
   const base = createAgentCommandTools({ projectRoot, fileService: scopedFiles, codeSearch, codeCache: scopedCache, projectLogger: () => {}, wrap: (tool) => tool });
diff --git a/backend/tests/unit/control-api-project-runtime.test.js b/backend/tests/unit/control-api-project-runtime.test.js
index e653f29..9525cf5 100644
--- a/backend/tests/unit/control-api-project-runtime.test.js
+++ b/backend/tests/unit/control-api-project-runtime.test.js
@@ -4,7 +4,12 @@ import test from "node:test";
 import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
-import { createControlApiProjectRuntime } from "../../scripts/control-api-project-runtime.mjs";
+import { EventEmitter, once } from "node:events";
+import { createServer } from "node:http";
+import { createControlApiProjectRuntime, startControlApiWorkers } from "../../scripts/control-api-project-runtime.mjs";
+import { startControlApi } from "../../scripts/control-api-lifecycle.mjs";
+import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
+import { createRuntimeLogger } from "../../src/core/runtime-logger.js";
 import { createProjectLifecycle } from "../../src/modules/projects/project-lifecycle.js";
 
 // Supply persisted project metadata and opaque existing database bytes without opening or migrating them.
@@ -60,3 +65,272 @@ test("mismatched default identity cannot reuse the running application's resourc
   await assert.rejects(start({ ...config, projectId: "PROJECT-WRONG" }), /identity differ/);
   assert.equal((await start(config)).projectId, config.projectId);
 });
+
+// Polls an asynchronous assertion predicate until it succeeds or times out.
+async function waitFor(predicate, timeoutMs = 4000) {
+  const deadline = Date.now() + timeoutMs;
+  while (Date.now() < deadline) {
+    const value = await predicate();
+    if (value) return value;
+    await new Promise((resolve) => setTimeout(resolve, 20));
+  }
+  throw new Error("Timed out waiting for in-process Control API workers.");
+}
+
+// Business purpose: verifies O1 in-process Watcher and Embedding Worker lifecycle, job recovery, immediate wake, terminal logging, and ordered shutdown before SQLite closes.
+// Technical description: exercises startControlApiWorkers, createControlApiProjectRuntime, and startControlApi shutdown over a real SQLite index database and simulated watcher events.
+async function verifyInProcessControlApiWorkers(context) {
+  const projectRoot = await mkdtemp(join(tmpdir(), "nodeforge-control-api-workers-"));
+  context.after(() => rm(projectRoot, { recursive: true, force: true }));
+  await mkdir(join(projectRoot, "src"), { recursive: true });
+  const indexDb = await createDatabaseService({ dataDir: projectRoot, runtimeDir: join(".forge", "runtime", "wc") });
+  const now = new Date().toISOString();
+  indexDb.run(
+    "INSERT INTO files (file_id, path, language, sha256, size_bytes, indexed_at) VALUES (?, ?, 'javascript', ?, 32, ?)",
+    ["FILE-BOOTSTRAP", "src/bootstrap.js", "sha256:0000000000000000000000000000000000000000000000000000000000000000", now]
+  );
+  indexDb.run(
+    "INSERT INTO symbols (symbol_id, file_id, name, kind, start_line, end_line) VALUES (?, ?, 'bootstrap', 'function', 1, 3)",
+    ["SYM-ORPHAN", "FILE-BOOTSTRAP"]
+  );
+  indexDb.run(
+    "INSERT INTO embedding_jobs (job_id, symbol_id, content_checksum, model, status, priority, attempts, next_retry_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, 'processing', 100, 1, NULL, NULL, ?, ?)",
+    ["JOB-RECOVER-1", "SYM-ORPHAN", "sha256:0000", "test-embed-model", now, now]
+  );
+
+  const terminalOutput = [];
+  const persistedLogs = [];
+  const runtimeLogger = createRuntimeLogger({
+    logEvent: (entry) => persistedLogs.push(entry),
+    output: { write: (chunk) => terminalOutput.push(String(chunk)) },
+    source: "project-watcher"
+  });
+
+  const rawWatcher = new EventEmitter();
+  const teardownEvents = [];
+  rawWatcher.close = async () => { teardownEvents.push("watcher"); };
+  const embeddedInputs = [];
+  let failOnce = true;
```
