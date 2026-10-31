// Verify project URLs preserve identity and global navigation restores only the current browser tab's selection.
import assert from "node:assert/strict";
import test from "node:test";
import { isProjectIndependentPath, projectArchitecturePath, projectSystemPath, projectCodingPath, projectIdFromPath, readSelectedProject, rememberSelectedProject, resolveSidebarProjectId } from "../lib/project-navigation.js";

test("project Architecture routes encode identities and distinguish the public directory and global pages", () => {
  assert.equal(projectArchitecturePath("PROJECT-NODEFORGE"), "/PROJECT-NODEFORGE");
  assert.equal(projectArchitecturePath("project with space"), "/project%20with%20space");
  assert.equal(projectIdFromPath("/PROJECT-NODEFORGE"), "PROJECT-NODEFORGE");
  assert.equal(projectIdFromPath("/project%20with%20space"), "project with space");
  for (const path of ["/", "/agents", "/system", "/coding", "/code", "/control-api/forge/v1"]) assert.equal(projectIdFromPath(path), null);
  assert.equal(projectArchitecturePath(null), "/");
});

test("Agents route is treated as project-independent by the route boundary without calling /lifecycle/list", () => {
  for (const path of ["/", "/agents", "/agents/profile"]) assert.equal(isProjectIndependentPath(path), true);
  for (const path of ["/PROJECT-NODEFORGE", "/PROJECT-NODEFORGE/system", "/PROJECT-NODEFORGE/coding", "/system", "/coding"]) assert.equal(isProjectIndependentPath(path), false);
});

test("System and Coding deep links preserve the explicit project identity", () => {
  for (const id of ["PROJECT-NODEFORGE", "PROJECT-B", "project with space"]) {
    assert.equal(projectSystemPath(id), `/${encodeURIComponent(id)}/system`);
    assert.equal(projectCodingPath(id), `/${encodeURIComponent(id)}/coding`);
    assert.equal(projectIdFromPath(projectSystemPath(id)), id);
    assert.equal(projectIdFromPath(projectCodingPath(id)), id);
  }
  for (const path of ["/PROJECT-B/unknown", "/PROJECT-B/system/extra", "/agents/system"]) assert.equal(projectIdFromPath(path), null);
  assert.equal(projectSystemPath(null), "/");
  assert.equal(projectCodingPath(null), "/");
});

test("selected projects remain tab-local rather than using shared local storage", (context) => {
  const session = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  globalThis.window = { sessionStorage: { getItem: (key) => session.get(key) ?? null, setItem: (key, value) => session.set(key, value) } };
  context.after(() => { if (original) Object.defineProperty(globalThis, "window", original); else delete globalThis.window; });
  assert.equal(readSelectedProject(), null);
  rememberSelectedProject("PROJECT-B");
  assert.equal(readSelectedProject(), "PROJECT-B");
});

test("sidebar project resolution preserves remembered project through /agents and prefers explicit route project", (context) => {
  const session = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  globalThis.window = { sessionStorage: { getItem: (key) => session.get(key) ?? null, setItem: (key, value) => session.set(key, value) } };
  context.after(() => { if (original) Object.defineProperty(globalThis, "window", original); else delete globalThis.window; });
  assert.equal(resolveSidebarProjectId({ pathname: "/agents" }), null);
  rememberSelectedProject("PROJECT-REMEMBERED");
  assert.equal(resolveSidebarProjectId({ pathname: "/agents" }), "PROJECT-REMEMBERED");
  assert.equal(projectArchitecturePath(resolveSidebarProjectId({ pathname: "/agents" })), "/PROJECT-REMEMBERED");
  assert.equal(projectSystemPath(resolveSidebarProjectId({ pathname: "/agents" })), "/PROJECT-REMEMBERED/system");
  assert.equal(projectCodingPath(resolveSidebarProjectId({ pathname: "/agents" })), "/PROJECT-REMEMBERED/coding");
  assert.equal(resolveSidebarProjectId({ pathname: "/PROJECT-ROUTE/system" }), "PROJECT-ROUTE");
  assert.equal(resolveSidebarProjectId({ explicitProjectId: "PROJECT-EXPLICIT", pathname: "/PROJECT-ROUTE" }), "PROJECT-EXPLICIT");
});

test("sidebar browser scenario module bundles real components and defines all 4 approved assertions", async () => {
  const { build } = await import("esbuild");
  const { createBrowserFixture, browserAssertions } = await import("./conversation-sidebar-navigation.browser.mjs");
  assert.equal(typeof createBrowserFixture, "function");
  assert.equal(Object.keys(browserAssertions).length, 4);
  const fixture = await createBrowserFixture({ sourceRoot: process.cwd(), build });
  assert.ok(fixture.html.includes("/fixture.js"));
  assert.ok(fixture.assets["/fixture.js"].includes("resolveSidebarProjectId"));
});

test("workspace navigation headers browser scenario module bundles Coding and Agents components and defines all 6 approved assertions", async () => {
  const { build } = await import("esbuild");
  const { createBrowserFixture, browserAssertions } = await import("./workspace-navigation-headers.browser.mjs");
  assert.equal(typeof createBrowserFixture, "function");
  assert.equal(Object.keys(browserAssertions).length, 6);
  const fixture = await createBrowserFixture({ sourceRoot: process.cwd(), build });
  assert.ok(fixture.html.includes("/fixture.js"));
  assert.ok(fixture.assets["/fixture.js"].includes("CodingWorkspaceMonitor"));
  assert.ok(fixture.assets["/fixture.js"].includes("AgentsPage"));
});
