// Executes committed project browser modules with Node-owned Chromium, viewport coverage and receipts.
import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { assertCodingBrowserStep } from "./browser-coding-contract.js";
import { browserStepSha } from "./browser-verification-evidence.js";

// Loads the approved module from the verification archive and rejects symlinks escaping that archive.
export async function loadProjectBrowserScenario(step, sourceRoot) {
  assertCodingBrowserStep(step);
  const root = await realpath(sourceRoot);
  let path;
  try { path = await realpath(resolve(root, step.scenario_path)); }
  catch (error) { throw Object.assign(new Error(`Committed browser module ${step.scenario_path} is missing: ${error.message}`), { code: "VERIFY_BROWSER_SCENARIO_REQUIRED", cause: error }); }
  if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) throw Object.assign(new Error("Browser scenario must be a file inside the committed source archive."), { code: "VERIFY_BROWSER_SCENARIO_REQUIRED" });
  const scenario = await import(pathToFileURL(path).href);
  if (typeof scenario.createBrowserFixture !== "function" || step.assertions.some((assertion) => !Object.hasOwn(scenario.browserAssertions ?? {}, assertion) || typeof scenario.browserAssertions[assertion] !== "function")) {
    throw Object.assign(new Error(`Browser module ${step.scenario_path} must export createBrowserFixture and browserAssertions implementing every approved assertion.`), { code: "VERIFY_BROWSER_SCENARIO_REQUIRED" });
  }
  return scenario;
}

// Serves a committed fixture locally and emits evidence only after all assertions succeed at every width.
export async function runProjectBrowserScenario({ step, sourceRoot, tools }) {
  const scenario = await loadProjectBrowserScenario(step, sourceRoot);
  const fixture = await scenario.createBrowserFixture({ sourceRoot, build: tools.build });
  if (typeof fixture?.html !== "string" || !fixture.html.trim() || !fixture.assets || typeof fixture.assets !== "object" || Object.entries(fixture.assets).some(([path, content]) => !/^\/[A-Za-z0-9_./-]+$/.test(path) || path.includes("..") || typeof content !== "string")) throw new Error("Browser fixture must return nonempty html and local text assets.");
  const server = createServer((request, response) => {
    if (Object.hasOwn(fixture.assets, request.url)) {
      response.setHeader("Content-Type", request.url.endsWith(".css") ? "text/css" : /\.m?js$/.test(request.url) ? "text/javascript" : request.url.endsWith(".html") ? "text/html" : request.url.endsWith(".svg") ? "image/svg+xml" : "text/plain");
      response.end(fixture.assets[request.url]);
    } else if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end(fixture.html); }
    else { response.statusCode = 404; response.end(); }
  });
  let browser;
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await tools.chromium.launch({ headless: true });
    const results = [];
    for (const viewport of step.viewports) {
      const context = await browser.newContext({ viewport: { width: viewport, height: 900 }, serviceWorkers: "block" });
      try {
        await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const errors = [];
        context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
        for (const assertion of step.assertions) {
          const page = await context.newPage();
          page.setDefaultTimeout(10000);
          try {
            await page.goto(origin);
            if (await page.evaluate(() => innerWidth) !== viewport) throw new Error("Browser viewport does not match the approved width.");
            await scenario.browserAssertions[assertion]({ page, viewport, origin });
            if (errors.length) throw new Error(`Browser page errors: ${errors.join("; ")}`);
          } catch (error) {
            throw Object.assign(new Error(`Browser assertion failed at ${viewport}px: ${assertion}: ${error.message}`), { code: error.code ?? "VERIFY_BROWSER_FAILED", cause: error });
          } finally { await page.close(); }
        }
        results.push({ viewport, assertions: [...step.assertions], passed: true });
      } finally { await context.close(); }
    }
    return { step_sha256: browserStepSha(step), browser_version: browser.version(), tool_versions: tools.versions, results };
  } finally {
    try { await browser?.close(); }
    finally { if (server.listening) await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())); }
  }
}
