// Exercises the real postinstall script in isolated repository-shaped fixtures so pnpm repairs root launchers without touching healthy tools or permitting targets outside installed dependencies.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../../scripts/repair-npm-bin-links.mjs", import.meta.url));

// Builds a disposable monorepo layout and invokes its copied script from the selected workspace, preserving the real repository's installed tools.
async function fixture(t, cwd = ".") {
  const root = await mkdtemp(join(tmpdir(), "repository-bin-repair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "backend/scripts"), { recursive: true });
  await copyFile(script, join(root, "backend/scripts/repair-npm-bin-links.mjs"));
  return { root, run: () => spawnSync(process.execPath, [join(root, "backend/scripts/repair-npm-bin-links.mjs")], { cwd: resolve(root, cwd), encoding: "utf8" }) };
}

for (const cwd of [".", "backend"]) {
  test(`repairs root launchers when invoked from ${cwd} and preserves healthy entries`, async (t) => {
    const { root, run } = await fixture(t, cwd);
    const bin = join(root, "node_modules/.bin");
    await mkdir(bin, { recursive: true });
    await mkdir(join(root, "node_modules/tool"), { recursive: true });
    const executable = "#!/bin/sh\nprintf 'tool-ok'\n";
    await writeFile(join(root, "node_modules/tool/cli"), executable);
    await chmod(join(root, "node_modules/tool/cli"), 0o755);
    await writeFile(join(bin, "broken"), "XSym\n0012\nabcdef\n../tool/cli\n");
    await writeFile(join(bin, "healthy"), executable);
    await chmod(join(bin, "healthy"), 0o755);
    await symlink("../tool/cli", join(bin, "linked"));
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Repaired 1/);
    assert.equal(await readFile(join(bin, "healthy"), "utf8"), executable);
    assert.equal(spawnSync(join(bin, "broken"), [], { encoding: "utf8" }).stdout, "tool-ok");
    assert.equal(spawnSync(join(bin, "linked"), [], { encoding: "utf8" }).stdout, "tool-ok");
  });
}

test("missing bin directory is healthy", async (t) => {
  const { run } = await fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /healthy/);
});

test("escaping targets fail observably before the launcher is changed", async (t) => {
  const { root, run } = await fixture(t);
  const bin = join(root, "node_modules/.bin");
  await mkdir(bin, { recursive: true });
  const marker = "XSym\n0012\nabcdef\n../../outside\n";
  await writeFile(join(bin, "escape"), marker);
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /target escapes node_modules/);
  assert.equal(await readFile(join(bin, "escape"), "utf8"), marker);
});
