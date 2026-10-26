// Checks that retained fixture access never elevates client-supplied commands
// and that verification archives cannot escape the project through symlinks.
import assert from "node:assert/strict";
import test from "node:test";
import { validateNamespaceRequest } from "../../test-environments/filesystem/namespace-request.mjs";
import { namespaceLaunch, namespaceProcess, namespaceVerificationCommand } from "../../test-environments/filesystem/namespace-launch.mjs";

test("namespace setup enters mapped UID zero before changing mount propagation", () => {
  const argv = namespaceLaunch(["-e", "console.log(process.getuid())"]);
  const boundary = argv.indexOf("--");
  assert.deepEqual(argv.slice(0, boundary), ["--user", "--map-auto", "--map-root-user"]);
  assert.deepEqual(argv.slice(boundary + 1, boundary + 7), ["/usr/bin/unshare", "--mount", "--propagation", "private", "--", process.execPath]);
  assert.deepEqual(argv.slice(boundary + 7), ["-e", "console.log(process.getuid())"]);
});

test("namespace verifier uses a nested nonzero mapping without privileged UID switches", () => {
  const argv = namespaceVerificationCommand([process.execPath, "--test", "suite.js"], "/project/archive");
  assert(argv.includes("--map-user=1000"));
  assert(argv.includes("--map-group=1000"));
  assert(!argv.some(value => /^(--setuid|--setgid|--reuid|--regid)/.test(value)));
  assert(!argv.includes("--clear-groups"));
  for (const flag of ["--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs"]) assert(argv.includes(flag));
  assert(argv.indexOf("--keep-caps") < argv.indexOf("/usr/bin/setpriv"));
  assert.equal(argv[0], "/usr/bin/unshare");
  assert.deepEqual(argv.slice(-5), ["--chdir", "/project/archive", process.execPath, "--test", "suite.js"]);
});

test("namespace launcher exports a coherent Bubblewrap and native entrypoint", () => {
  const args = ["-e", "console.log(process.getuid())"];
  const result = namespaceProcess(args, {}, {});
  assert.equal(result.command, process.execPath);
  assert(result.argv[0].endsWith("/namespace-bwrap.mjs"));
  assert.deepEqual(result.argv.slice(1), args);
  assert.deepEqual(namespaceProcess(args, {}, { NODEFORGE_FILESYSTEM_NAMESPACE_ENGINE: "unshare" }),
    { command: "/usr/bin/unshare", argv: namespaceLaunch(args) });
  assert.throws(() => namespaceProcess(args, {}, { NODEFORGE_FILESYSTEM_NAMESPACE_ENGINE: "invalid" }));
});

test("retained namespace uses the same setup order with parent-linked lifetime", () => {
  const argv = namespaceLaunch(["server.mjs", "/project/control"], { retained: true });
  assert(argv.indexOf("--fork") < argv.indexOf("--"));
  assert(argv.indexOf("--kill-child=TERM") < argv.indexOf("--"));
  assert.deepEqual(argv.slice(-2), ["server.mjs", "/project/control"]);
});

test("namespace verification accepts an exact project Node command", () => {
  const request = { action: "run", cwd: "/project/archive", argv: [process.execPath, "--test", "suite.js"] };
  assert.doesNotThrow(() => validateNamespaceRequest(request, "/project", value => value));
  assert.throws(() => validateNamespaceRequest({ ...request, argv: ["sh", "-c", "id"] }, "/project", value => value));
  assert.throws(() => validateNamespaceRequest({ ...request, argv: [process.execPath, "bad\0argument"] }, "/project", value => value));
});

test("namespace verification rejects outside cwd and symlink escape", () => {
  const request = { action: "run", cwd: "/project-other", argv: [process.execPath, "--test", "suite.js"] };
  assert.throws(() => validateNamespaceRequest(request, "/project", value => value), /escapes/);
  assert.throws(() => validateNamespaceRequest({ ...request, cwd: "/project/link" }, "/project",
    value => value === "/project/link" ? "/outside" : value), /escapes/);
});
