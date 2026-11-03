# Scoped Unified Git Diff (Part 5 of 9) — PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792 (r1, Round 3)

- **Base Commit SHA**: `fe0df3f39ef7a203057a88e6722475cad047d6c0` (`tree_sha: e5b54a82be4116509639934abe445408d5a85e81`)
- **Target / Review Commit SHA**: `6f78aa84c7260b5a439d142b116d9121ef67c3d1`
- **Source / Ledger Revision (`commit_id`)**: `OWNER-CONV-SE-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-CORR-HANDOFF-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-SE-R3`
- **Diff Line Window**: Lines 621–775 of 1395

```diff
-    else log("SYSTEM", "Commands: /q quit · /r api|watcher|ui restart · /copy select · /save <file>");
+    await executeForegroundCommand(value, {
+      onShutdown: () => shutdown(),
+      onRestart: (service) => restartService(service),
+      onCopy: () => enterCopyMode(state),
+      onSave: (targetPath) => saveLogs(targetPath),
+      onHelp: (message) => log("SYSTEM", message)
+    });
   }
 
   // Summary: Applies a keypress to the input buffer with editing shortcuts.
diff --git a/backend/scripts/start-control-api.mjs b/backend/scripts/start-control-api.mjs
index 6f06ab9..3f124f2 100644
--- a/backend/scripts/start-control-api.mjs
+++ b/backend/scripts/start-control-api.mjs
@@ -17,7 +17,7 @@ import { readControlApiConfig } from "./control-api-config.mjs";
 import { createUnifiedStreamPublisher } from "./control-api-unified-stream.mjs";
 import { startControlApi } from "./control-api-lifecycle.mjs";
 import { createProjectLifecycle } from "../src/modules/projects/project-lifecycle.js";
-import { createControlApiProjectRuntime } from "./control-api-project-runtime.mjs";
+import { createControlApiProjectRuntime, startControlApiWorkers } from "./control-api-project-runtime.mjs";
 import { createBuilderContext } from "./control-api-builder-context.mjs";
 import { createOnWriteVerifier } from "./control-api-file-verification.mjs";
 import { createControlApiAgent } from "./control-api-agent.mjs";
@@ -62,17 +62,21 @@ import { reviewPhaseResume } from "../src/modules/supervisor/review/review-revis
 import { createNotebookStore } from "../src/modules/projects/notebook-store.js";
 import { createNotebookProjectAuth } from "../src/modules/governance/notebook-project-auth.js";
 
+// Business purpose: initializes the Control API process, default in-process Watcher and Embedding Workers, and multi-project application registry.
+// Technical description: opens shared SQLite storage, wires createControlApiProjectRuntime with getDefaultWorkers to prevent duplicate default-project workers, builds the default application with startProjectWorkers: true, and starts the HTTP lifecycle server.
+export async function bootstrapControlApi() {
 const config = readControlApiConfig();
 const { port, host } = config;
 let testService;
+let defaultProjectWorkers;
 const storage = await createControlApiStorage({
   config,
   onWrite: createOnWriteVerifier({ getTestService: () => testService })
 });
 const { processLock, controlDb, indexDb } = storage;
-const projectLifecycle = config.projectCatalogPath ? await createProjectLifecycle({ catalogPath: config.projectCatalogPath, startRuntime: createControlApiProjectRuntime({ projectRoot: config.cwd, projectId: config.projectId }) }) : undefined;
+const projectLifecycle = config.projectCatalogPath ? await createProjectLifecycle({ catalogPath: config.projectCatalogPath, startRuntime: createControlApiProjectRuntime({ projectRoot: config.cwd, projectId: config.projectId, getDefaultWorkers: () => defaultProjectWorkers }) }) : undefined;
 // Builds a complete application bundle while leaving startup initialization and lifecycle admission intact.
-async function createProjectApplication({ config, storage, onTestService = () => {} }) {
+async function createProjectApplication({ config, storage, startProjectWorkers = false, onTestService = () => {} }) {
 const { fileService, protocolStorage, conversationStateStore, controlDb, indexDb } = storage;
 let testService;
 const { logEvent, readLogEvents } = createProjectLogService({ projectRoot: config.cwd, fileService });
@@ -171,6 +175,15 @@ const sprintLeaderIntake = createSprintLeaderIntakeService({ fileService, roadma
 const dispatchTicket = createTicketRunDispatch({ disposition: ticketPipelineDisposition, intake: sprintLeaderIntake, sprintRegistry, ticketStatusStore, checkpoints: supervisorRuntime.agentCheckpoints, queueStore: supervisorRuntime.queueStore, protocolStorage, conversationStateStore, dispatchTask, coderRecovery: supervisorRuntime.coderRecovery, blockerRecovery: supervisorRuntime.blockerRecovery, resumeCompletedReview: supervisorRuntime.resumeCompletedReview, reconcileReviewDependencies: supervisorRuntime.reconcileReviewDependencies, agentResolver: agentRoleResolver, agentOccupancy, projectId, projectLogger: runtimeLogger.emit });
 workers.push(storage.disposal.own({ stop: dispatchTicket.close }, "stop", 10));
 dispatchTicket.start();
+const projectWorkers = startProjectWorkers ? storage.disposal.own(startControlApiWorkers({
+  projectRoot: config.cwd,
+  projectId,
+  indexDb,
+  runtimeLogger: createRuntimeLogger({ logEvent: createAgentActivityLogger({ logEvent, executionActivity }), source: "project-watcher" }),
+  codeCache,
+  subscriptions
+}), "stop", 10) : null;
+if (projectWorkers) workers.push(projectWorkers);
 // Reconciles a retained unknown-provider blocker stage so the owner can clear a stuck ticket and a later RUN may re-arm it.
 const ticketBlockerReconcileService = async ({ projectId: requestedProjectId, ticketId, actor } = {}) => {
   if (!supervisorRuntime.blockerRecovery?.reconcileTicket) throw Object.assign(new Error("Blocker reconciliation is unavailable."), { code: "BLOCKER_RECONCILE_UNAVAILABLE", statusCode: 409 });
@@ -223,7 +236,7 @@ const services = {
   humanDecisionService: createHumanDecisionService({ decisions, bus }),
   projectLifecycle
 };
-return { services, storage, codeCache, ticketWorkspaceService, workers };
+return { services, storage, codeCache, ticketWorkspaceService, workers, projectWorkers };
 } catch (error) {
   try { await storage.disposal.close(); } catch (cleanupError) {
     throw new AggregateError([error, cleanupError], "Project application startup and rollback failed.");
@@ -231,7 +244,10 @@ return { services, storage, codeCache, ticketWorkspaceService, workers };
   throw error;
 }
 }
-const application = await createProjectApplication({ config, storage, onTestService: (value) => { testService = value; } });
+const application = await createProjectApplication({ config, storage, startProjectWorkers: true, onTestService: (value) => { testService = value; } });
+defaultProjectWorkers = application.projectWorkers;
 const projectApplications = createProjectApplicationRegistry({ projectLifecycle, defaultApplication: application, defaultRoot: config.cwd, createApplication: createProjectApplication });
 const api = createControlApiHttp({ services: application.services, resolveProjectServices: projectLifecycle ? projectApplications.resolve : undefined });
-startControlApi({ api, port, host, indexDb, controlDb, processLock, codeCache: application.codeCache, ticketWorkspaceService: application.ticketWorkspaceService, projectLifecycle, workers: [...application.workers, { stop: projectApplications.close }] });
+return startControlApi({ api, port, host, indexDb, controlDb, processLock, codeCache: application.codeCache, ticketWorkspaceService: application.ticketWorkspaceService, projectLifecycle, workers: [...application.workers, { stop: projectApplications.close }] });
+}
+await bootstrapControlApi();
diff --git a/backend/src/modules/index/code-search.js b/backend/src/modules/index/code-search.js
index 0257b00..fba209d 100644
--- a/backend/src/modules/index/code-search.js
+++ b/backend/src/modules/index/code-search.js
@@ -130,7 +130,7 @@ export function createCodeSearch({ database } = {}) {
     return typeof path === "string" && (/(^|\/)tests?(\/|$)/.test(path) || path.includes(".test.") || path.includes("__tests__"));
   }
   // Defines symbolLanguage function behavior for code-search.js.
-  function symbolLanguage(path) { const extension = path.slice(path.lastIndexOf(".")).toLowerCase(); return { ".js": "javascript", ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript", ".php": "php", ".css": "css" }[extension] ?? null; }
+  function symbolLanguage(path) { const extension = path.slice(path.lastIndexOf(".")).toLowerCase(); return { ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript", ".php": "php", ".css": "css" }[extension] ?? null; }
   // Defines indexVersion function behavior for code-search.js.
   function indexVersion() { return `IDX-${database.all("SELECT version FROM index_metadata LIMIT 1")[0]?.version ?? 0}`; }
 }
diff --git a/backend/src/modules/index/dependency-graph.js b/backend/src/modules/index/dependency-graph.js
index 9b3794d..c2c3fd5 100755
--- a/backend/src/modules/index/dependency-graph.js
+++ b/backend/src/modules/index/dependency-graph.js
@@ -23,12 +23,15 @@ export function createDependencyGraph({ database, files, projectRoot } = {}) {
     }
   });
 
-  // Defines resolveImport function behavior for dependency-graph.js.
+  // Resolves relative or project-root imports, falling back from a pinned review snapshot path to its canonical project path when needed.
   function resolveImport(sourcePath, source, external) {
     if (!source || external) return null;
     const targetPath = isAbsolute(source)
       ? relative(projectRoot, source).split(/\\/).join("/")
       : posix.normalize(posix.join(posix.dirname(sourcePath), source));
-    return files.findByPath(targetPath)?.file_id ?? null;
+    const directId = files.findByPath(targetPath)?.file_id ?? null;
+    if (directId) return directId;
+    const canonicalPath = targetPath.replace(/^\.forge\/runtime\/(?:tickets\/ticket-verification\/[^/]+\/snapshot|reports\/[^/]+-snapshot)\/[a-f0-9]{40,64}\//, "");
+    return canonicalPath !== targetPath ? (files.findByPath(canonicalPath)?.file_id ?? null) : null;
   }
 }
diff --git a/backend/src/modules/index/incremental-indexer.js b/backend/src/modules/index/incremental-indexer.js
index fcb67d9..8f3206e 100755
--- a/backend/src/modules/index/incremental-indexer.js
+++ b/backend/src/modules/index/incremental-indexer.js
@@ -98,7 +98,7 @@ export function createIncrementalIndexer({ database, projectRoot, registry = ext
       });
       return false;
     }
-    if (sha256 === file.sha256 && conversion.needed(file)) {
+    if (sha256 === file.sha256 && !event.force && conversion.needed(file)) {
       // Conversion of an unchanged source uses the accepted summary writer while
       // retaining all structural identities and graph rows from that same source.
       withTransaction(() => {
@@ -205,5 +205,5 @@ export function createIncrementalIndexer({ database, projectRoot, registry = ext
 // Maps supported source extensions to their indexed language names.
 function languageForPath(path) {
   const extension = extname(path).toLowerCase();
-  return { ".js": "javascript", ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript", ".php": "php", ".css": "css" }[extension] ?? null;
+  return { ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript", ".php": "php", ".css": "css" }[extension] ?? null;
 }
diff --git a/backend/src/modules/index/index-record-writer.js b/backend/src/modules/index/index-record-writer.js
index be56535..827feb5 100644
--- a/backend/src/modules/index/index-record-writer.js
+++ b/backend/src/modules/index/index-record-writer.js
@@ -169,7 +169,7 @@ export function createIndexRecordWriter({ database, graph, embeddingJobs, embedd
 // Maps supported source extensions to their indexed language names.
 function languageForPath(path) {
   const extension = extname(path).toLowerCase();
-  return { ".js": "javascript", ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript", ".php": "php", ".css": "css" }[extension] ?? null;
+  return { ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript", ".php": "php", ".css": "css" }[extension] ?? null;
 }
 
 // Creates unique identifiers for persisted index records.
diff --git a/backend/src/modules/index/parser/index.js b/backend/src/modules/index/parser/index.js
```
