# Scoped Unified Git Diff (Part 3 of 9) — PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792 (r1, Round 3)

- **Base Commit SHA**: `fe0df3f39ef7a203057a88e6722475cad047d6c0` (`tree_sha: e5b54a82be4116509639934abe445408d5a85e81`)
- **Target / Review Commit SHA**: `6f78aa84c7260b5a439d142b116d9121ef67c3d1`
- **Source / Ledger Revision (`commit_id`)**: `OWNER-CONV-SE-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-CORR-HANDOFF-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-SE-R3`
- **Diff Line Window**: Lines 311–465 of 1395

```diff
+// Summary: Reads embedding queue counts from SQLite and API worker logs and renders a progress bar with throughput.
 function embeddingProgressLine() {
-  if (Date.now() - embeddingCache.at < 2000) return embeddingCache.text;
-  let text = "";
+  const logProgress = parseWorkerLogProgress();
+  if (logProgress.lastWorkerLog === instanceEmbeddingCache.lastWorkerLog && Date.now() - instanceEmbeddingCache.at < 2000) {
+    return instanceEmbeddingCache.text;
+  }
+  let done = logProgress.done;
+  let failed = logProgress.failed;
+  let active = logProgress.active;
+  let vectors = logProgress.vectors;
   try {
-    const database = new DatabaseSync(join(process.cwd(), ".forge", "runtime", "wc", "index.db"), { readOnly: true });
+    const database = new DatabaseSync(join(projectRoot, ".forge", "runtime", "wc", "index.db"), { readOnly: true });
     try {
       const counts = Object.fromEntries(
         database.prepare("SELECT status, COUNT(*) AS count FROM embedding_jobs GROUP BY status").all()
           .map((row) => [row.status, Number(row.count)])
       );
-      const done = counts.completed ?? 0;
-      const failed = counts.failed ?? 0;
-      const active = (counts.pending ?? 0) + (counts.retry_wait ?? 0) + (counts.processing ?? 0);
-      const total = done + failed + active;
-      const vectors = Number(database.prepare("SELECT COUNT(*) AS count FROM symbol_embeddings").all()[0]?.count ?? 0);
-      if (total > 0) {
-        const width = 12;
-        const filled = Math.round((width * (done + failed)) / total);
-        const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
-        const percent = Math.round(((done + failed) / total) * 100);
-        const previous = embeddingCache.counts;
-        let rate = "";
-        if (previous && embeddingCache.at > 0) {
-          const elapsed = (Date.now() - embeddingCache.at) / 1000;
-          const delta = done - previous.done;
-          if (elapsed > 0 && delta >= 0) rate = ` · ${(delta / elapsed).toFixed(1)}/s`;
-        }
-        embeddingCache.counts = { done };
-        const failedPart = failed > 0 ? ` · \x1b[31m${failed} failed\x1b[0m` : "";
-        text = `\x1b[38;5;245membed \x1b[36m${bar}\x1b[0m\x1b[38;5;245m ${percent}% · ${done}/${total} done · ${active} queued · ${vectors} vectors${rate}${failedPart}\x1b[0m`;
-      }
+      done = Math.max(done, counts.completed ?? 0);
+      failed = Math.max(failed, counts.failed ?? 0);
+      active = (counts.pending ?? 0) + (counts.retry_wait ?? 0) + (counts.processing ?? 0);
+      vectors = Math.max(vectors, Number(database.prepare("SELECT COUNT(*) AS count FROM symbol_embeddings").all()[0]?.count ?? 0));
     } finally {
       database.close();
     }
-  // eslint-disable-next-line no-silent-catch -- SQLite probe: watcher DB may not exist yet on first run.
-  } catch { text = ""; }
-  embeddingCache = { at: Date.now(), text, counts: embeddingCache.counts };
+  // eslint-disable-next-line no-silent-catch -- SQLite probe: watcher DB may not exist yet when worker logs arrive first.
+  } catch { /* fallback to parsed worker log counts */ }
+  let text = "";
+  const total = done + failed + active;
+  if (total > 0 || logProgress.hasWorkerEvent) {
+    const effectiveTotal = Math.max(1, total);
+    const width = 12;
+    const filled = Math.round((width * (done + failed)) / effectiveTotal);
+    const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
+    const percent = Math.round(((done + failed) / effectiveTotal) * 100);
+    const previous = instanceEmbeddingCache.counts;
+    let rate = "";
+    if (previous && instanceEmbeddingCache.at > 0) {
+      const elapsed = (Date.now() - instanceEmbeddingCache.at) / 1000;
+      const delta = done - previous.done;
+      if (elapsed > 0 && delta >= 0) rate = ` · ${(delta / elapsed).toFixed(1)}/s`;
+    }
+    instanceEmbeddingCache.counts = { done };
+    const failedPart = failed > 0 ? ` · \x1b[31m${failed} failed\x1b[0m` : "";
+    text = `\x1b[38;5;245membed \x1b[36m${bar}\x1b[0m\x1b[38;5;245m ${percent}% · ${done}/${total} done · ${active} queued · ${vectors} vectors${rate}${failedPart}\x1b[0m`;
+  }
+  instanceEmbeddingCache = { at: Date.now(), text, counts: instanceEmbeddingCache.counts, lastWorkerLog: logProgress.lastWorkerLog };
+  embeddingCache = instanceEmbeddingCache;
   return text;
 }
 
diff --git a/backend/scripts/dev-foreground.mjs b/backend/scripts/dev-foreground.mjs
index bc31a87..8f54778 100644
--- a/backend/scripts/dev-foreground.mjs
+++ b/backend/scripts/dev-foreground.mjs
@@ -1,43 +1,190 @@
-// Summary: Runs the API, watcher, and web development services under one interactive controller.
+// Summary: Runs the API (with in-process Watcher and Embedding Workers) and web development services under one interactive controller.
 import { spawn } from "node:child_process";
 import { writeFileSync } from "node:fs";
+import { resolve } from "node:path";
 import process from "node:process";
+import { fileURLToPath } from "node:url";
 import { createMouseSelection } from "./dev-foreground-selection.mjs";
 import { createKeyParser } from "./dev-foreground-keys.mjs";
 import { createForegroundView } from "./dev-foreground-view.mjs";
 import { alive, findMatchingPids } from "./dev-foreground-process.mjs";
 import { createForegroundLogReceiver, formatForegroundLine } from "./dev-foreground-line.mjs";
 
-process.chdir(new URL("../..", import.meta.url).pathname);
-
-const definitions = {
-  api: { command: process.execPath, args: ["backend/scripts/start-control-api.mjs"] },
-  watcher: { command: process.execPath, args: ["backend/scripts/start-project-watcher.mjs"] },
-  ui: { command: "pnpm", args: ["--dir", "ui/nextjs", "dev"] }
-};
+// Business purpose: provides the supervised service definitions, autocomplete suggestions, and status messages for the foreground development controller.
+// Technical description: defines only the api and ui child process commands (since Watcher and Embedding Workers run in-process inside Control API) and exports the corresponding CLI help and startup strings.
+export function getForegroundServiceDefinitions() {
+  return {
+    definitions: {
+      api: { command: process.execPath, args: ["backend/scripts/start-control-api.mjs"] },
+      ui: { command: "pnpm", args: ["--dir", "ui/nextjs", "dev"] }
+    },
+    suggestions: ["/q quit", "/r api restart", "/r ui restart", "/copy", "/save log.txt"],
+    startupMessage: "Services starting: api, ui",
+    helpMessage: "Commands: /q quit · /r api|ui restart · /copy select · /save <file>"
+  };
+}
+export const {
+  definitions,
+  suggestions,
+  startupMessage: FOREGROUND_STARTUP_MESSAGE,
+  helpMessage: FOREGROUND_HELP_MESSAGE
+} = getForegroundServiceDefinitions();
 const ESC = String.fromCharCode(27);
 const BEL = String.fromCharCode(7);
 const ansiPattern = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
 const oscPattern = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, "g");
-const suggestions = ["/q quit", "/r api restart", "/r watcher restart", "/r ui restart", "/copy", "/save log.txt"];
 const children = new Map();
 const serviceState = new Map(Object.keys(definitions).map((name) => [name, "starting"]));
 const logLines = [];
 let shuttingDown = false;
 
+// Parses and dispatches an interactive foreground command to the corresponding controller action.
+export async function executeForegroundCommand(rawInput, { onShutdown, onRestart, onCopy, onSave, onHelp } = {}) {
+  const value = String(rawInput ?? "").trim();
+  if (!value) return null;
+  const lower = value.toLowerCase();
+  if (lower === "/q" || lower === "/quit" || lower === "exit") {
+    await onShutdown?.();
+    return { action: "quit" };
+  }
+  const restart = lower.match(/^\/r\s+(api|ui)$/);
+  if (restart) {
+    await onRestart?.(restart[1]);
+    return { action: "restart", service: restart[1] };
+  }
+  if (lower === "/copy") {
+    onCopy?.();
+    return { action: "copy" };
+  }
+  if (lower.startsWith("/save")) {
+    const targetPath = value.slice(5).trim() || "dev-foreground.log";
+    onSave?.(targetPath);
+    return { action: "save", path: targetPath };
+  }
+  onHelp?.(FOREGROUND_HELP_MESSAGE);
```
