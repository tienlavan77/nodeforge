// Runs approved Coding assertions in real Chromium against the committed ticket UI, never the live API.
import { runProjectBrowserScenario } from "./browser-project-scenario.js";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { join, sep } from "node:path";
import { assertCodingBrowserStep, CODING_BROWSER_ASSERTIONS } from "./browser-coding-contract.js";
import { verifyCodingAssertion } from "./browser-coding-scenarios.js";
import { browserStepSha } from "./browser-verification-evidence.js";
import { buildCodingBrowserFixture } from "./browser-coding-bundle.js";
import { verifyCodingLayoutAssertion } from "./browser-coding-layout-scenarios.js";
import { verifyCodingPresenceAssertion } from "./browser-coding-presence-scenarios.js";

// Loads explicitly installed browser tools without downloading packages or browser binaries during a ticket RUN.
export function loadBrowserTools(projectRoot) {
  const toolsRoot = join(projectRoot, "node_modules");
  const require = createRequire(join(projectRoot, "package.json"));
  try {
    process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
    return { chromium: require(join(toolsRoot, "playwright")).chromium, build: require(join(toolsRoot, "esbuild")).build, versions: { playwright: require(join(toolsRoot, "playwright/package.json")).version, esbuild: require(join(toolsRoot, "esbuild/package.json")).version } };
  } catch (error) {
    throw Object.assign(new Error(`Browser tools are unavailable: ${error.message}. Run pnpm install at the project root, then pnpm browser:install before ticket verification.`), { code: "VERIFY_BROWSER_TOOLS_MISSING", cause: error });
  }
}

// Serves only the compiled ticket fixture on loopback and returns a complete assertion-by-viewport receipt.
export async function runBrowserVerification({ step, sourceRoot, projectRoot, tools = loadBrowserTools(projectRoot) }) {
  assertCodingBrowserStep(step);
  const [sourcePath, projectPath] = await Promise.all([realpath(sourceRoot), realpath(projectRoot)]);
  if (sourcePath !== projectPath && !sourcePath.startsWith(`${projectPath}${sep}`)) throw new Error("Browser source must remain inside the project root.");
  if (step.scenario_path) return runProjectBrowserScenario({ step, sourceRoot, tools });
  const assets = new Map();
  // Defines fixtureFor function behavior for browser-verification-runner.js.
  const fixtureFor = (index) => index >= 17 ? "layout" : index >= 13 ? "presence" : "fixture";
  for (const fixture of new Set(step.assertions.map((assertion) => fixtureFor(CODING_BROWSER_ASSERTIONS.indexOf(assertion))))) {
    const bundle = await buildCodingBrowserFixture({ build: tools.build, sourceRoot, presence: fixture === "presence", layout: fixture === "layout" });
    for (const file of bundle.outputFiles) assets.set(`/${fixture}.${file.path.endsWith(".css") ? "css" : "js"}`, file.text);
  }
  const server = createServer((request, response) => {
    if (["/", "/presence", "/layout", "/away"].includes(request.url)) {
      const fixture = request.url === "/layout" ? "layout" : request.url === "/presence" ? "presence" : "fixture";
      response.setHeader("Content-Type", "text/html");
      response.end(request.url === "/away" ? '<!doctype html><html><body>Away</body></html>' : `<!doctype html><html><head><link rel="stylesheet" href="/${fixture}.css"></head><body><div id="root"></div><script src="/${fixture}.js"></script></body></html>`);
    }
    else if (assets.has(request.url)) { response.setHeader("Content-Type", request.url.endsWith(".css") ? "text/css" : "text/javascript"); response.end(assets.get(request.url)); }
    else { response.statusCode = 404; response.end(); }
  });
  let browser;
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await tools.chromium.launch({ headless: true });
    const results = [];
    for (const width of step.viewports) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        await context.route("**/*", (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.setDefaultTimeout(10000);
        let currentFixture;
        for (const assertion of step.assertions) {
          const index = CODING_BROWSER_ASSERTIONS.indexOf(assertion);
          const fixture = fixtureFor(index);
          if (fixture !== currentFixture) {
            await page.goto(`${origin}${fixture === "fixture" ? "/" : `/${fixture}`}`);
            if (await page.evaluate(() => window.innerWidth) !== width) throw new Error("Browser viewport does not match the approved width.");
            await page.waitForFunction((name) => Boolean(name === "layout" ? window.layoutFixture : name === "presence" ? window.presenceFixture : window.browserFixture?.update), fixture);
            currentFixture = fixture;
          }
          if (index >= 17) await verifyCodingLayoutAssertion(index, page);
          else if (index >= 13) await verifyCodingPresenceAssertion(index, page);
          else await verifyCodingAssertion(index, page);
        }
        if (errors.length) throw new Error(`Browser page errors: ${errors.join("; ")}`);
        results.push({ viewport: width, assertions: [...step.assertions], passed: true });
      } finally { await context.close(); }
    }
    return { step_sha256: browserStepSha(step), browser_version: browser.version(), tool_versions: tools.versions, results };
  } finally {
    try { await browser?.close(); }
    finally { if (server.listening) await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())); }
  }
}
