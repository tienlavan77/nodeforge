# Scoped Unified Git Diff (Part 4 of 9) — PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792 (r1, Round 3)

- **Base Commit SHA**: `fe0df3f39ef7a203057a88e6722475cad047d6c0` (`tree_sha: e5b54a82be4116509639934abe445408d5a85e81`)
- **Target / Review Commit SHA**: `6f78aa84c7260b5a439d142b116d9121ef67c3d1`
- **Source / Ledger Revision (`commit_id`)**: `OWNER-CONV-SE-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-CORR-HANDOFF-PLAN-PROJECT-NODEFORGE-8679120d-e401-43fa-ad67-21fd61c50792-SE-R3`
- **Diff Line Window**: Lines 466–620 of 1395

```diff
+  return { action: "help", message: FOREGROUND_HELP_MESSAGE };
+}
+
+// Business purpose: creates a programmable foreground process supervisor for starting, restarting, and stopping api and ui services while streaming child logs into the terminal view.
+// Technical description: spawns configured child processes, attaches UTF-8 line buffers to stdout/stderr, executes /r api and /r ui restarts via SIGTERM and respawn, and cleans up supervised children on shutdown.
+export function createForegroundController({
+  serviceDefinitions = definitions,
+  output = process.stdout,
+  projectRoot = process.cwd(),
+  getGitInfo
+} = {}) {
+  const controllerChildren = new Map();
+  const controllerState = new Map(Object.keys(serviceDefinitions).map((name) => [name, "starting"]));
+  const controllerLogs = [];
+  let controllerShuttingDown = false;
+  const view = createForegroundView({
+    children: controllerChildren,
+    serviceState: controllerState,
+    logLines: controllerLogs,
+    suggestions,
+    isActive: () => !controllerShuttingDown,
+    output,
+    projectRoot,
+    getGitInfo
+  });
+  // Appends sanitized log lines from a supervised service into the controller log buffer.
+  function recordLog(name, value) {
+    const plain = String(value).replace(ansiPattern, "").replace(oscPattern, "");
+    for (const line of plain.replace(/\r/g, "").split("\n")) {
+      if (line) controllerLogs.push({ name, line });
+    }
+    while (controllerLogs.length > 2000) controllerLogs.shift();
+  }
+  // Spawns a supervised child service and wires its stdout/stderr streams into the log buffer.
+  function startService(name) {
+    if (controllerChildren.has(name)) return controllerChildren.get(name);
+    const definition = serviceDefinitions[name];
+    const child = spawn(definition.command, definition.args, {
+      cwd: definition.cwd ?? projectRoot,
+      stdio: ["ignore", "pipe", "pipe"],
+      env: { ...process.env, ...(definition.env ?? {}), ...(name === "ui" ? { NEXT_TELEMETRY_DISABLED: "1" } : {}) }
+    });
+    controllerChildren.set(name, child);
+    controllerState.set(name, "running");
+    for (const stream of [child.stdout, child.stderr]) {
+      const receive = createForegroundLogReceiver((line) => recordLog(name, line));
+      stream.on("data", receive);
+      stream.once("end", receive.finish);
+    }
+    child.once("exit", (code, signal) => {
+      if (controllerChildren.get(name) !== child) return;
+      controllerChildren.delete(name);
+      controllerState.set(name, "exited");
+      if (!controllerShuttingDown) recordLog(name, `exited (${signal ?? code ?? "unknown"})`);
+    });
+    recordLog(name, `started (pid ${child.pid})`);
+    return child;
+  }
+  // Stops a supervised child service with SIGTERM and waits for process exit.
+  async function stopService(name) {
+    const child = controllerChildren.get(name);
+    if (!child) return;
+    controllerChildren.delete(name);
+    controllerState.set(name, "stopped");
+    if (!child.killed && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
+    if (child.exitCode === null && child.signalCode === null) {
+      await new Promise((resolveExit) => child.once("exit", resolveExit));
+    }
+    recordLog(name, "stopped");
+  }
+  // Restarts a supervised child service by stopping the current PID and spawning a replacement.
+  async function restartSupervisedService(name) {
+    recordLog("SYSTEM", `${name}: restarting...`);
+    await stopService(name);
+    if (!controllerShuttingDown) {
+      controllerState.set(name, "running");
+      startService(name);
+      recordLog("SYSTEM", `${name}: restarted successfully (pid ${controllerChildren.get(name)?.pid ?? "unknown"})`);
+    }
+  }
+  // Stops all supervised services and marks the controller as shut down.
+  async function shutdownController() {
+    if (controllerShuttingDown) return;
+    controllerShuttingDown = true;
+    await Promise.all([...controllerChildren.keys()].map((name) => stopService(name)));
+  }
+  // Executes an interactive command (/r api, /r ui, /r watcher, /q, etc.) against this controller.
+  function runCommand(rawInput) {
+    return executeForegroundCommand(rawInput, {
+      onShutdown: () => shutdownController(),
+      onRestart: (service) => restartSupervisedService(service),
+      onHelp: (message) => recordLog("SYSTEM", message)
+    });
+  }
+  return Object.freeze({
+    children: controllerChildren,
+    serviceState: controllerState,
+    logLines: controllerLogs,
+    start: startService,
+    stop: stopService,
+    restartService: restartSupervisedService,
+    shutdown: shutdownController,
+    executeCommand: runCommand,
+    render: view.render
+  });
+}
+
 const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
 const { render } = createForegroundView({ children, serviceState, logLines, suggestions, isActive: () => interactive && !shuttingDown });
-if (!interactive) {
-  for (const name of Object.keys(definitions)) {
-    const definition = definitions[name];
-    const child = spawn(definition.command, definition.args, { stdio: ["ignore", "pipe", "pipe"] });
-    children.set(name, child);
-    attachServiceOutput(child, name);
+if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
+  process.chdir(new URL("../..", import.meta.url).pathname);
+  if (!interactive) {
+    for (const name of Object.keys(definitions)) {
+      const definition = definitions[name];
+      const child = spawn(definition.command, definition.args, { stdio: ["ignore", "pipe", "pipe"] });
+      children.set(name, child);
+      attachServiceOutput(child, name);
+    }
+    process.once("SIGINT", () => process.exit(0));
+    process.once("SIGTERM", () => process.exit(0));
+  } else {
+    runInteractive();
   }
-  process.once("SIGINT", () => process.exit(0));
-  process.once("SIGTERM", () => process.exit(0));
-} else {
-  runInteractive();
 }
 
 // Summary: Starts raw-mode input handling and the interactive redraw loop.
@@ -49,7 +196,7 @@ function runInteractive() {
   process.stdin.resume();
   process.stdin.setEncoding("utf8");
 
-  log("SYSTEM", "Services starting: api, watcher, ui");
+  log("SYSTEM", FOREGROUND_STARTUP_MESSAGE);
   for (const name of Object.keys(definitions)) start(name);
   render(state);
 
@@ -82,13 +229,13 @@ function runInteractive() {
     state.historyIndex = -1;
     if (!value) return;
     state.history.unshift(value);
-    const lower = value.toLowerCase();
-    if (lower === "/q" || lower === "/quit" || lower === "exit") return shutdown();
-    const restart = lower.match(/^\/r\s+(api|watcher|ui)$/);
-    if (restart) await restartService(restart[1]);
-    else if (lower === "/copy") enterCopyMode(state);
-    else if (lower.startsWith("/save")) saveLogs(value.slice(5).trim() || "dev-foreground.log");
```
