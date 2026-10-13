// Runs focused real-browser UI verification against project-installed Chromium without depending on the API server or Playwright's Node version.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const WebSocket = require(fileURLToPath(new URL("../../../ui/nextjs/node_modules/next/dist/compiled/ws/index.js", import.meta.url)));

// Launches only the browser installed inside this project, with an isolated project-local user profile.
export async function launchProjectChromium(profile) {
  const playwrightRequire = createRequire(require.resolve("playwright"));
  const browsers = join(dirname(playwrightRequire.resolve("playwright-core")), ".local-browsers");
  const build = (await readdir(browsers)).find((entry) => entry.startsWith("chromium_headless_shell-"));
  if (!build) throw new Error("Project Chromium headless shell is missing.");
  const executable = join(browsers, build, "chrome-headless-shell-linux64/chrome-headless-shell");
  const process = spawn(executable, ["--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { process.kill(); reject(new Error(`Chromium startup timed out: ${stderr}`)); }, 15000);
    process.once("error", (error) => { clearTimeout(timeout); reject(error); });
    process.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Chromium exited ${code}: ${stderr}`)); });
    process.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12000); const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
  });
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let sequence = 0; const pending = new Map();
  socket.on("message", (message) => {
    const response = JSON.parse(String(message)); const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error) request.reject(new Error(response.error.message)); else request.resolve(response.result);
  });

  // Sends a protocol command to the browser or its attached page with bounded failure handling.
  function call(method, params = {}, sessionId) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Chromium command timed out: ${method}`)); }, 10000);
      pending.set(id, { resolve: (result) => { clearTimeout(timeout); resolve(result); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  // Opens a test-only page and exposes concrete UI interactions rather than mocking React event handlers.
  async function page(url) {
    const { targetId } = await call("Target.createTarget", { url });
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    const send = (method, params) => call(method, params, sessionId);
    await send("Runtime.enable"); await send("Page.enable");

    // Reads observable page state without treating an agent assertion as browser evidence.
    async function evaluate(expression) {
      const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
      return response.result.value;
    }

    // Waits for the real UI or API state to settle instead of relying on fixed sleeps.
    async function wait(expression) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(50); }
      throw new Error(`Browser assertion timed out: ${expression}`);
    }

    // Clicks the rendered control through Chromium's input pipeline.
    async function click(expression) {
      const point = await evaluate(`(() => {const control = ${expression}; if (!control || control.disabled) throw new Error("Control missing or disabled"); control.scrollIntoView({block:"center"}); const rect = control.getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()`);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    }
    return { send, evaluate, wait, click };
  }
  return { page, version: await call("Browser.getVersion"), close: async () => { socket.close(); process.kill(); } };
}
