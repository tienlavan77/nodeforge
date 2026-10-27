// Verifies the public REST preflight classification against real temporary host directories.
// These cases prove metadata suggestions, non-mutating intake selection and actionable failures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, startLifecycleHttpServer } from "./multi-project-lifecycle-support.js";

test("REST preflight classifies existing, empty, absent and unsafe roots without creating metadata", async () => {
  const f = await fixture();
  const lifecycle = await f.open();
  const server = await startLifecycleHttpServer(lifecycle);
  try {
    const root = f.roots[0];
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "source-app", description: "Source", author: "Owner" }));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), '[remote "origin"]\n url = https://example.org/source.git\n');
    // Exercises the deployed HTTP boundary and JSON payload, rather than inspecting implementation text.
    const preflight = async (path) => {
      const result = await fetch(server.baseUrl + "/forge/v1/projects/preflight", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ root: path })
      });
      assert.equal(result.status, 200);
      return result.json();
    };
    const existing = await preflight(root);
    assert.equal(existing.status, "existing");
    assert.deepEqual(existing.suggestions, { name: "source-app", description: "Source", author: "Owner", git_url: "https://example.org/source.git" });
    assert.ok(!(await readdir(root)).includes(".forge"));
    await writeFile(join(root, "package.json"), "null");
    const withoutMetadata = await preflight(root);
    assert.equal(withoutMetadata.status, "existing");
    assert.deepEqual(withoutMetadata.suggestions, { git_url: "https://example.org/source.git" });
    const admitted = await fetch(server.baseUrl + "/forge/v1/projects", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ root, name: "Null metadata" })
    });
    assert.equal(admitted.status, 201, await admitted.text());
    const empty = join(f.directory, "empty");
    await mkdir(empty);
    assert.equal((await preflight(empty)).status, "new");
    const absent = join(f.directory, "absent");
    assert.equal((await preflight(absent)).status, "new");
    await assert.rejects(readFile(absent), { code: "ENOENT" });
    for (const path of ["relative", join(f.directory, "missing-parent", "child"), join(root, "sample.js")]) {
      const invalid = await preflight(path);
      assert.equal(invalid.status, "invalid");
      assert.equal(typeof invalid.code, "string");
      assert.ok(invalid.message.length > 10);
    }
    const alias = join(f.directory, "alias");
    await symlink(root, alias);
    assert.equal((await preflight(alias)).status, "invalid");
    await writeFile(join(root, ".git", "config"), '[remote "origin"]\n url = https://user:password@example.org/source.git\n');
    assert.equal((await preflight(root)).suggestions.git_url, undefined);
  } finally {
    await server.close();
    await f.cleanup();
  }
});
