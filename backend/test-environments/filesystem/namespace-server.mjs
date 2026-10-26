// Keeps filesystem fixtures in one private namespace across Coder and Reviewer
// runs. A project-local owner-only socket executes Node verification as mapped
// UID/GID 1000 with no capabilities; explicit stop releases the private mounts.
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { chmodSync, chownSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { provisionNamespaceFixtures, namespaceCommand } from "./namespace-fixtures.mjs";
import { validateNamespaceRequest } from "./namespace-request.mjs";
import { namespaceVerificationCommand } from "./namespace-launch.mjs";

const [control, repository] = process.argv.slice(2);
process.umask(0o022);
const fixture = provisionNamespaceFixtures(join(control, "fixtures"));
const socketPath = join(control, "runner.sock");
let active;
let stopping = false;
// Preserves process-local readiness separately from acceptance: mounted fixtures
// alone do not assert that the three mandatory integration cases have passed.
const identity = {
  status: "provisioned", pid: process.pid, repository, socketPath,
  manifestPath: fixture.manifestPath, manifest: fixture.manifest, checksum: fixture.checksum,
  uidMap: readFileSync("/proc/self/uid_map", "utf8"), gidMap: readFileSync("/proc/self/gid_map", "utf8"),
  acl: namespaceCommand("getfacl", ["--numeric", join(fixture.manifest.acl.root, "denied.txt")]),
  startedAt: new Date().toISOString()
};
writeFileSync(join(control, "session.json"), JSON.stringify(identity, null, 2) + "\n");

// Reads private verification archives as their host owner, now mapped to setup
// root. The nested verifier maps this same owner to UID 1000 without changing
// any archive permissions or inheriting effective capabilities on Node exec.
function inspectRequest(request) {
  validateNamespaceRequest(request, repository, realpathSync);
  return createHash("sha256").update(readFileSync(join(request.cwd, "backend/tests/integration/project-filesystem-environment.test.js"))).digest("hex");
}

// Runs only project-local Node commands, preserving the verifier's exact cwd and
// argv. Output and exit status remain receipts even when an assertion fails.
const server = createServer(socket => {
  let input = "";
  let received = false;
  const send = value => { if (!socket.destroyed) socket.write(JSON.stringify(value) + "\n"); };
  socket.on("error", error => console.error("Namespace client:", error.message));
  socket.on("data", chunk => {
    if (received) return;
    input += chunk;
    if (Buffer.byteLength(input) > 65536) { socket.destroy(new Error("Request too large")); return; }
    if (!input.includes("\n")) return;
    received = true;
    try {
      const request = JSON.parse(input.split("\n")[0]);
      if (request.action === "status") { send({ identity }); socket.end(); return; }
      if (active) throw new Error("VERIFICATION_BLOCKED: a verification is already running");
      if (request.action === "stop") { send({ exitCode: 0 }); socket.end(); shutdown(); return; }
      const testChecksum = inspectRequest(request);
      const startedAt = new Date().toISOString();
      const receiptPath = join(control, `verification-${randomUUID()}.json`);
      const output = [];
      const [command, ...argv] = namespaceVerificationCommand(request.argv, request.cwd);
      active = spawn(command, argv, {
        cwd: repository, env: { ...process.env, NODEFORGE_FILESYSTEM_FIXTURES: fixture.manifestPath,
          TMPDIR: join(control, "fixtures/work"), TMP: join(control, "fixtures/work"), TEMP: join(control, "fixtures/work"), PWD: request.cwd },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const running = active;
      socket.once("close", () => { if (active === running) running.kill("SIGTERM"); });
      for (const stream of ["stdout", "stderr"]) active[stream].on("data", chunk => {
        const frame = { stream, data: chunk.toString() };
        output.push(frame);
        send(frame);
      });
      active.on("error", error => { console.error("Namespace verification:", error); output.push({ stream: "stderr", data: error.message }); });
      active.once("close", (code, signal) => {
        active = undefined;
        const receipt = { startedAt, completedAt: new Date().toISOString(), cwd: request.cwd, argv: request.argv,
          exitCode: code !== null && code >= 0 ? code : 1, nativeExitCode: code, signal,
          command, launchArgv: argv, manifestPath: fixture.manifestPath, manifestChecksum: fixture.checksum,
          testChecksum, output };
        writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
        send({ exitCode: receipt.exitCode, receiptPath });
        socket.end();
        if (stopping) server.close();
      });
    } catch (error) {
      console.error("Namespace request rejected:", error);
      send({ error: error.message, exitCode: 1 });
      socket.end();
    }
  });
});

// Waits for any running verification to finish before releasing mounts. A normal
// test exit keeps the server alive; fixture cleanup is a separate owner action.
function shutdown() {
  stopping = true;
  if (!active) server.close();
}
server.on("close", () => {
  fixture.cleanup();
  writeFileSync(join(control, "stopped.json"), JSON.stringify({ stoppedAt: new Date().toISOString() }) + "\n");
});
server.on("error", error => { console.error("Namespace server:", error); fixture.cleanup(); process.exitCode = 1; });
server.listen(socketPath, () => {
  chownSync(socketPath, 0, 0);
  chmodSync(socketPath, 0o600);
  console.log(JSON.stringify(identity));
});
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
