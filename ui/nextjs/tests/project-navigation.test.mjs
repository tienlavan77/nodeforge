// Verify project URLs preserve identity and global navigation restores only the current browser tab's selection.
import assert from "node:assert/strict";
import test from "node:test";
import { projectArchitecturePath, projectSystemPath, projectCodingPath, projectIdFromPath, readSelectedProject, rememberSelectedProject } from "../lib/project-navigation.js";

test("project Architecture routes encode identities and distinguish the public directory and global pages", () => {
  assert.equal(projectArchitecturePath("PROJECT-NODEFORGE"), "/PROJECT-NODEFORGE");
  assert.equal(projectArchitecturePath("project with space"), "/project%20with%20space");
  assert.equal(projectIdFromPath("/PROJECT-NODEFORGE"), "PROJECT-NODEFORGE");
  assert.equal(projectIdFromPath("/project%20with%20space"), "project with space");
  for (const path of ["/", "/agents", "/system", "/coding", "/code", "/control-api/forge/v1"]) assert.equal(projectIdFromPath(path), null);
  assert.equal(projectArchitecturePath(null), "/");
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
