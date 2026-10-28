// Verifies live project management client behavior, non-polling directory initialization, SSE progress updates, and dynamic route-scoped projectId resolution.
// Business purpose: ensures ProjectDirectory issues only one initial GET /forge/v1/projects request without polling, updates running project progress and readiness via SSE, builds full configuration updates, and isolates workspace/child route identities across slug and legacy project URLs.
// Technical description: tests refreshProjectDirectory, applyProjectDirectoryStreamEvent, createProjectEditForm, buildProjectConfigurationUpdate, resolveActiveProjectId, and route-scoped Node client request isolation.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applyProjectDirectoryStreamEvent,
  computeProjectProgressPercent,
  getProjectDirectory,
  refreshProjectDirectory,
  removeDirectoryProject,
  upsertDirectoryProject
} from "../lib/project-directory-client.js";
import {
  buildProjectConfigurationUpdate,
  createProjectEditForm
} from "../lib/project-lifecycle-client.js";
import { resolveActiveProjectId } from "../lib/home-page-constants.js";
import { projectArchitecturePath, projectCodingPath, projectIdFromPath, projectSystemPath } from "../lib/project-navigation.js";
import { createNodeClient } from "../lib/node-client.js";

test("AC-1 & AC-5: ProjectDirectory source eliminates 1500ms setTimeout polling and refreshes catalog once on mount", async () => {
  const directorySource = await readFile(new URL("../components/project-directory.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(directorySource, /setTimeout\s*\([^)]*,\s*1500\s*\)/);
  assert.doesNotMatch(directorySource, /reloadOperation\s*\(/);
  assert.match(directorySource, /refreshProjectDirectory\s*\(/);
  assert.match(directorySource, /connectProjectStream\s*\(/);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input, "http://127.0.0.1:3100");
    calls.push({ pathname: url.pathname, method: init.method ?? "GET" });
    if (url.pathname === "/forge/v1/projects" && (init.method ?? "GET") === "GET") {
      return Response.json({
        projects: [
          { project_id: "alpha-service", name: "Alpha Service", root: "/srv/alpha", readiness: "running", progress: { stage: "comment_normalization", status: "running", stages: { preflight: "completed", comment_normalization: "running" } } },
          { project_id: "PROJECT-LEGACY-1", name: "Legacy App", root: "/srv/legacy", readiness: "ready", progress: { stage: "startup/readiness", status: "succeeded" } }
        ]
      });
    }
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  };
  try {
    const projects = await refreshProjectDirectory();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, "/forge/v1/projects");
    assert.equal(projects.length, 2);
    assert.equal(projects[0].project_id, "alpha-service");
    assert.equal(projects[0].readiness, "running");
    assert.ok(projects[0].percent > 0 && projects[0].percent < 100);
    assert.equal(projects[1].project_id, "PROJECT-LEGACY-1");
    assert.equal(projects[1].readiness, "ready");
    assert.equal(projects[1].percent, 100);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AC-2 & AC-6: SSE stream events update running project percentage, stage, readiness, and diagnostics without polling", async () => {
  upsertDirectoryProject({
    project_id: "stream-app",
    name: "Stream App",
    root: "/srv/stream-app",
    readiness: "running",
    progress: { stage: "preflight", status: "running", stages: { preflight: "running" } }
  });
  const initial = getProjectDirectory().projects.find((p) => p.project_id === "stream-app");
  assert.equal(initial.readiness, "running");
  const initialPercent = initial.percent;

  applyProjectDirectoryStreamEvent("stream-app", {
    event_id: "EVT-1",
    event_type: "agent.activity",
    schema_version: 1,
    project_id: "stream-app",
    timestamp: "2026-10-28T00:00:01Z",
    payload: { agent_id: "coder", activity_type: "progress", status: "working", summary: "Stage scan/index: running" }
  });
  const mid = getProjectDirectory().projects.find((p) => p.project_id === "stream-app");
  assert.equal(mid.readiness, "running");
  assert.equal(mid.percent, 65);
  assert.ok(mid.percent > initialPercent);
  assert.equal(mid.progress.stage, "scan/index");

  applyProjectDirectoryStreamEvent("stream-app", {
    event_id: "EVT-1B",
    event_type: "agent.activity",
    schema_version: 1,
    project_id: "stream-app",
    timestamp: "2026-10-28T00:00:01Z",
    payload: { agent_id: "coder", activity_type: "progress", status: "working", summary: "Stage embedding: running" }
  });
  const embeddingStage = getProjectDirectory().projects.find((p) => p.project_id === "stream-app");
  assert.equal(embeddingStage.percent, 90);
  assert.ok(embeddingStage.percent > mid.percent);

  // Foreign project events are ignored.
  applyProjectDirectoryStreamEvent("stream-app", {
    event_id: "EVT-FOREIGN",
    event_type: "project.ready",
    schema_version: 1,
    project_id: "other-project",
    timestamp: "2026-10-28T00:00:02Z",
    payload: { readiness: "ready", percent: 100 }
  });
  assert.equal(getProjectDirectory().projects.find((p) => p.project_id === "stream-app").readiness, "running");

  // Completion event transitions card to ready and 100%.
  applyProjectDirectoryStreamEvent("stream-app", {
    event_id: "EVT-2",
    event_type: "agent.activity",
    schema_version: 1,
    project_id: "stream-app",
    timestamp: "2026-10-28T00:00:03Z",
    payload: { agent_id: "coder", activity_type: "completed", status: "success", summary: "Stage startup/readiness: succeeded" }
  });
  const ready = getProjectDirectory().projects.find((p) => p.project_id === "stream-app");
  assert.equal(ready.readiness, "ready");
  assert.equal(ready.percent, 100);
  removeDirectoryProject("stream-app");
});

test("AC-3 & AC-9: Edit form helper round-trips every Section 5 project configuration field", () => {
  const sourceProject = {
    project_id: "config-slug",
    name: "Config Slug",
    description: "Full config project",
    author: "Architect",
    root: "/srv/config-slug",
    git_url: "https://example.org/config.git",
    default_branch: "main",
    default_workflow_id: "WF-DEFAULT",
    language: "javascript",
    package_manager: "pnpm",
    comment_language: "vi",
    commands: { test: "pnpm test", lint: "pnpm lint", build: "pnpm build", dev: "pnpm dev" },
    default_agents: { architecture_manager: "am-1", sprint_leader: "sl-1", coder: "coder-1", reviewer: "rev-1" },
    watch: { include: ["src/**", "lib/**"], exclude: ["node_modules/**", "dist/**"] },
    tags: ["platform", "nextjs"],
    homepage_url: "https://example.org",
    docs_url: "https://example.org/docs",
    metadata: { tier: "production" }
  };
  const form = createProjectEditForm(sourceProject);
  const updated = buildProjectConfigurationUpdate({
    ...form,
    name: "Renamed Project",
    comment_language: "en",
    commands_test: "node --test",
    watch_include: "app/**, components/**"
  });
  assert.equal(updated.name, "Renamed Project");
  assert.equal(updated.description, "Full config project");
  assert.equal(updated.author, "Architect");
  assert.equal(updated.git_url, "https://example.org/config.git");
  assert.equal(updated.default_branch, "main");
  assert.equal(updated.default_workflow_id, "WF-DEFAULT");
  assert.equal(updated.language, "javascript");
  assert.equal(updated.package_manager, "pnpm");
  assert.equal(updated.comment_language, "en");
  assert.deepEqual(updated.commands, { test: "node --test", lint: "pnpm lint", build: "pnpm build", dev: "pnpm dev" });
  assert.deepEqual(updated.default_agents, { architecture_manager: "am-1", sprint_leader: "sl-1", coder: "coder-1", reviewer: "rev-1" });
  assert.deepEqual(updated.watch, { include: ["app/**", "components/**"], exclude: ["node_modules/**", "dist/**"] });
  assert.deepEqual(updated.tags, ["platform", "nextjs"]);
  assert.equal(updated.homepage_url, "https://example.org");
  assert.equal(updated.docs_url, "https://example.org/docs");
  assert.deepEqual(updated.metadata, { tier: "production" });
});

test("AC-4 & AC-12: dynamic route projectId scopes ArchitectureWorkspace and /[projectId] child screens across slug and legacy IDs", async () => {
  for (const id of ["modern-slug-app", "PROJECT-7403B6AF"]) {
    assert.equal(projectIdFromPath(projectArchitecturePath(id)), id);
    assert.equal(projectIdFromPath(projectCodingPath(id)), id);
    assert.equal(projectIdFromPath(projectSystemPath(id)), id);
    assert.equal(resolveActiveProjectId({ pathname: `/${id}` }), id);
    assert.equal(resolveActiveProjectId({ pathname: `/${id}/coding` }), id);
    assert.equal(resolveActiveProjectId({ pathname: `/${id}/system` }), id);
    assert.equal(resolveActiveProjectId({ routeProjectId: id }), id);
    assert.equal(resolveActiveProjectId({ explicitProjectId: id, routeProjectId: "other" }), id);
  }

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input, "http://127.0.0.1:3100");
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    return Response.json({ items: [], project_id: url.searchParams.get("project") });
  };
  try {
    const slugClient = createNodeClient("modern-slug-app");
    const legacyClient = createNodeClient("PROJECT-7403B6AF");
    await slugClient.listConversations({ projectId: "wrong", agentId: "arch-1" });
    await legacyClient.listConversations({ projectId: "wrong", agentId: "arch-1" });
    await slugClient.getProjectDashboard("wrong");
    await legacyClient.getProjectDashboard("wrong");

    assert.equal(calls[0].url.searchParams.get("project"), "modern-slug-app");
    assert.equal(calls[1].url.searchParams.get("project"), "PROJECT-7403B6AF");
    assert.equal(calls[2].url.pathname, "/forge/v1/projects/modern-slug-app/dashboard");
    assert.equal(calls[3].url.pathname, "/forge/v1/projects/PROJECT-7403B6AF/dashboard");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AC-1..12: browser scenario module exports createBrowserFixture, bundles /[projectId] route adapters, and defines all 6 approved assertions", async () => {
  const { build } = await import("esbuild");
  const { createBrowserFixture, browserAssertions } = await import("./project-lifecycle.browser.mjs");
  assert.equal(typeof createBrowserFixture, "function");
  assert.equal(Object.keys(browserAssertions).length, 6);
  const fixture = await createBrowserFixture({ sourceRoot: process.cwd(), build });
  assert.ok(fixture.html.includes("/fixture.js"));
  assert.ok(fixture.assets["/fixture.js"].includes("resolveActiveProjectId"));
  assert.equal(computeProjectProgressPercent({ readiness: "ready" }), 100);
});
