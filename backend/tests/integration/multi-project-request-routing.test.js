// Verifies one real Control API selects root-local services using existing project request contracts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createControlApiHttp } from "../../scripts/control-api-http.mjs";
import { createProjectApplicationRegistry } from "../../scripts/control-api-project-applications.mjs";
import { createProjectRuntimeDisposal } from "../../src/modules/projects/project-runtime-disposal.js";
import { createRoutingApplication, createRoutingStorage } from "./multi-project-request-support.js";
import { SPRINT } from "../fixtures/sprint-registry-migration-fixture.mjs";

// Starts actual transport and production service composition over two independent project roots.
async function fixture(context, multi = true) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "request-routing-")));
  const runtimes = new Map();
  const disposal = createProjectRuntimeDisposal();
  for (const projectId of ["PROJECT-A", "PROJECT-B"]) {
    const projectRoot = join(base, projectId);
    await mkdir(projectRoot);
    runtimes.set(projectRoot, { projectId, projectRoot, close: async () => {} });
  }
  const lifecycle = {
    list: () => [...runtimes.values()].filter(disposal.isAvailable).map((runtime) => ({ root: runtime.projectRoot, projectId: runtime.projectId })),
    get: async (root) => runtimes.get(root), registerCleanup: disposal.registerCleanup
  };
  const root = join(base, "PROJECT-B");
  const config = { cwd: root, dataDir: join(root, ".forge/runtime/nf"), projectId: "PROJECT-B", protocolStorageRoot: ".forge/runtime/protocol-storage" };
  const storage = await createRoutingStorage({ config });
  const application = await createRoutingApplication({ config, storage });
  const applications = createProjectApplicationRegistry({ projectLifecycle: lifecycle, defaultApplication: application, defaultRoot: root, createApplication: createRoutingApplication, createStorage: createRoutingStorage });
  const api = createControlApiHttp({ services: application.services, resolveProjectServices: multi ? applications.resolve : undefined });
  const server = api.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try { await applications.close(); } finally { await rm(base, { recursive: true, force: true }); }
  });
  const origin = `http://127.0.0.1:${server.address().port}/forge/v1/`;
  // Sends existing JSON payloads through HTTP, asserting the transport status before examining data.
  async function request(path, { method = "GET", body, status = 200 } = {}) {
    const response = await fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  return { base, request, applications, runtimes, disposal, lifecycle };
}

test("one HTTP server uses selected plan, sprint, Git, direct-code and conversation services", async (context) => {
  const f = await fixture(context);
  for (const projectId of ["PROJECT-A", "PROJECT-B"]) {
    const sprint = JSON.parse(JSON.stringify(SPRINT).replaceAll("PROJECT-NODEFORGE", projectId));
    sprint.objective = `Scope for ${projectId}`;
    await f.request("sprints", { method: "POST", status: 201, body: { project_id: projectId, sprint_plan: sprint } });
    const plans = await f.request(`plans?project=${projectId}`);
    assert.equal(plans.length, 1);
    const sprints = await f.request(`sprints?project=${projectId}`);
    assert.equal(sprints[0].objective, `Scope for ${projectId}`);
    const services = await f.applications.resolve(projectId);
    assert.equal(await f.applications.resolve(projectId), services);
    assert.equal(services.sprintRegistry.get(SPRINT.id).project_id, projectId);
    await writeFile(join(f.base, projectId, `${projectId}.txt`), projectId);
    const git = await f.request(`git/status?project=${projectId}`);
    assert.match(JSON.stringify(git), new RegExp(`${projectId}\\.txt`));
    assert.doesNotMatch(JSON.stringify(git), new RegExp(`${projectId === "PROJECT-A" ? "PROJECT-B" : "PROJECT-A"}\\.txt`));
    const checkpoints = await f.request(`code/checkpoints?project=${projectId}`);
    assert.equal(checkpoints.checkpoints[0].task_id, `CODE-${projectId}`);
    await f.request(`code/run?project=${projectId}`, { method: "POST", status: 409, body: { project: projectId, text: "Must remain behind approved plan gate" } });
    const conversation = await f.request("conversations", { method: "POST", status: 201, body: { project: projectId, title: `Conversation ${projectId}`, agent_id: "architecture-manager" } });
    assert.equal(conversation.project_id, projectId);
    const listed = await f.request(`conversations?project_id=${projectId}`);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].title, `Conversation ${projectId}`);
    const input = JSON.parse(await readFile(join(f.base, projectId, `.forge/runtime/nf/code-requests/CODE-${projectId}.json`), "utf8"));
    assert.equal(input.project_id, projectId);
  }
});

test("missing, unknown and contradictory identifiers never borrow the default runtime", async (context) => {
  const f = await fixture(context);
  for (const path of ["plans", "sprints", "git/status", "code/checkpoints", "conversations"]) {
    await f.request(path, { status: 400 });
    await f.request(`${path}?project=UNKNOWN`, { status: 404 });
    await f.request(`${path}?project=`, { status: 400 });
  }
  await f.request("conversations?project=PROJECT-A&project_id=PROJECT-B", { status: 409 });
  await f.request("conversations?project=PROJECT-A", { method: "POST", status: 409, body: { project_id: "PROJECT-B" } });
  await f.request("conversations", { method: "POST", status: 409, body: { project_id: "PROJECT-A", project: "PROJECT-B" } });
  await f.request("conversations?project_id=PROJECT-A", { method: "POST", status: 400, body: { title: "Not a POST alias" } });
  await f.request("plans?project_id=PROJECT-A", { status: 400 });
  await f.request("projects/PROJECT-A/tickets/TASK/run?project=PROJECT-B", { method: "POST", status: 409, body: {} });
  assert.deepEqual(await f.request("conversations?project=PROJECT-B&project_id=PROJECT-B"), []);
  assert.equal((await f.request("health")).status, "ok");
  assert.equal((await f.request("version")).api, "forge/v1");
});

test("single-project HTTP callers retain query and payload compatibility", async (context) => {
  const f = await fixture(context, false);
  const result = await f.request("conversations?project=PROJECT-B", { method: "POST", status: 201, body: { project_id: "PROJECT-B", title: "Legacy", agent_id: "architecture-manager" } });
  assert.equal(result.project_id, "PROJECT-B");
  assert.equal((await f.request("conversations?project_id=PROJECT-B"))[0].title, "Legacy");
  assert.deepEqual(await f.request("plans?project=PROJECT-B"), []);
  await f.request("plans?project=PROJECT-A", { status: 409 });
});

test("removal and re-addition replace disposed application bundles", async (context) => {
  const f = await fixture(context);
  const first = await f.applications.resolve("PROJECT-A");
  const root = join(f.base, "PROJECT-A");
  await f.disposal.releaseRuntime(f.runtimes.get(root));
  assert.equal(await f.applications.resolve("PROJECT-A"), undefined);
  await f.request("plans?project=PROJECT-A", { status: 404 });
  f.runtimes.set(root, { projectId: "PROJECT-A", projectRoot: root, close: async () => {} });
  const second = await f.applications.resolve("PROJECT-A");
  assert.notEqual(first, second);
  await f.request("plans?project=PROJECT-A");
});
