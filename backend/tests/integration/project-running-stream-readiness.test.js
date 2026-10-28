// Verifies SSE stream access for running projects and workspace business route isolation (AC-4, AC-7).
// Business purpose: ensures `GET /forge/v1/stream?project=<projectId>` succeeds (`200 OK`) and streams live intake progress via `project-stream.js` while a project is in `running` state, while all other workspace business APIs remain protected by `readiness === "ready"` (`404 PROJECT_NOT_FOUND`).
// Technical description: starts an HTTP Control API server backed by `createProjectLifecycle` and `createForgeV1Router`, connects to `/forge/v1/stream` during `running` intake, asserts live SSE events and `404 PROJECT_NOT_FOUND` on business routes, and verifies business route access after `ready`.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpApi } from "../../src/transport/http/server.js";
import { createForgeV1Router } from "../../src/transport/http/forge-v1-router.js";
import { createProjectLifecycle } from "../../src/modules/projects/project-lifecycle.js";
import { startProjectRuntime } from "../../src/modules/projects/project-runtime.js";
import { generateEnglishCommentsForFile } from "../../src/modules/projects/project-comment-normalization.js";

const watcherFactory = () => {
  const watcher = new EventEmitter();
  watcher.close = async () => {};
  setImmediate(() => watcher.emit("ready"));
  return watcher;
};

test("AC-4 & AC-7: GET /forge/v1/stream?project=<projectId> connects and streams live progress while project is running, while business APIs enforce readiness === ready", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "nf-running-stream-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const projectRoot = join(baseDir, "streaming-project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "inventory.js"), "export function countItems(items) {\n  return items.length;\n}\n", "utf8");

  let onCoderStarted;
  let releaseCoder;
  const coderStarted = new Promise((resolve) => { onCoderStarted = resolve; });
  const coderGate = new Promise((resolve) => { releaseCoder = resolve; });

  const lifecycle = await createProjectLifecycle({
    catalogPath: join(baseDir, "global", "projects.json"),
    logger: { error() {}, warn() {} },
    startRuntime: (options) => startProjectRuntime({
      ...options,
      watcherFactory,
      coderNormalizer: async ({ path, content }) => {
        onCoderStarted(options.projectId);
        await coderGate;
        return generateEnglishCommentsForFile(path, content, { commentLanguage: "en" });
      },
      embeddingProvider: {
        async embed() {
          return [1, 0, 0];
        }
      }
    })
  });
  t.after(() => lifecycle.close());

  const resolveProjectRouter = async (projectId) => {
    const entry = lifecycle.list().find((item) => item.projectId === projectId);
    const runtime = entry ? await lifecycle.get(entry.root) : undefined;
    if (!runtime) return undefined;
    return createForgeV1Router({
      expectedProjectId: projectId,
      projectStream: runtime,
      planStore: { list: () => [], listPlans: () => [] },
      ticketCrudService: { listTickets: () => [] },
      sprintPlanUploadService: { list: () => [] },
      conversationCrudService: { list: () => [] }
    });
  };

  const router = createForgeV1Router({ projectLifecycle: lifecycle, resolveProjectRouter });
  const server = createHttpApi({ forgeV1Router: router }).createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const intakePromise = fetch(`${origin}/forge/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Streaming Intake App", root: projectRoot })
  });

  const runningProjectId = await coderStarted;
  assert.equal(lifecycle.directory()[0].readiness, "running");

  // 1. Connect to GET /forge/v1/stream?project=<projectId> while project is locked in running state.
  const streamResponse = await fetch(`${origin}/forge/v1/stream?project=${runningProjectId}`, {
    signal: AbortSignal.timeout(8000)
  });
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = streamResponse.body.getReader();
  t.after(() => reader.cancel());
  const decoder = new TextDecoder();
  const receivedEvents = [];
  let buffer = "";

  const readUntil = async (predicate) => {
    while (!predicate(receivedEvents)) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "SSE stream closed before expected events arrived");
      buffer += decoder.decode(chunk.value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
        if (dataLine) receivedEvents.push(JSON.parse(dataLine.slice(5).trim()));
      }
    }
  };

  await readUntil((events) => events.length >= 2);
  assert.equal(receivedEvents[0].event_type, "stream.connected");
  assert.equal(receivedEvents[1].event_type, "stream.snapshot");
  assert.equal(receivedEvents[1].payload.runtime?.readiness, "running");

  // 2. While project is running, other workspace business APIs and conversation streams must remain gated with 404 PROJECT_NOT_FOUND.
  for (const blockedPath of [
    `/forge/v1/plans?project=${runningProjectId}`,
    `/forge/v1/sprints?project=${runningProjectId}`,
    `/forge/v1/conversations?project_id=${runningProjectId}`,
    `/projects/${runningProjectId}/conversations/CONV-1/stream`
  ]) {
    const blockedRes = await fetch(`${origin}${blockedPath}`);
    assert.equal(blockedRes.status, 404, `Expected ${blockedPath} to return 404 while running`);
    const body = await blockedRes.json();
    assert.equal(body.error.code.toLowerCase(), "project_not_found");
  }

  // Unknown project stream still returns 404 PROJECT_NOT_FOUND.
  const unknownStream = await fetch(`${origin}/forge/v1/stream?project=unknown-project-id`);
  assert.equal(unknownStream.status, 404);
  assert.equal((await unknownStream.json()).error.code.toLowerCase(), "project_not_found");

  // 3. Release Coder gate and observe live progress events (agent.activity and watcher.file_indexed) over the open SSE stream.
  releaseCoder();
  await readUntil((events) =>
    events.some((e) => e.event_type === "agent.activity") &&
    events.some((e) => e.event_type === "watcher.file_indexed" && e.payload?.path === "inventory.js")
  );

  const intakeResponse = await intakePromise;
  assert.equal(intakeResponse.status, 201);
  assert.equal(lifecycle.directory()[0].readiness, "ready");

  // 4. After readiness transitions to ready, workspace business APIs succeed.
  const ticketsAfterReady = await fetch(`${origin}/forge/v1/tickets?project=${runningProjectId}`);
  assert.equal(ticketsAfterReady.status, 200);
  assert.deepEqual(await ticketsAfterReady.json(), []);
  const conversationsAfterReady = await fetch(`${origin}/forge/v1/conversations?project_id=${runningProjectId}`);
  assert.equal(conversationsAfterReady.status, 200);
  assert.deepEqual(await conversationsAfterReady.json(), []);
});
