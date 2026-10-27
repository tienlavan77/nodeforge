// Integration tests for extended project configuration validation and round-trip persistence in .forge/runtime/project.json.
// Business purpose: guarantees that all extended project metadata fields (commands, default_agents, watch, URLs, tags,
// author, git_url, comment_language default) validate against schemas/project/project.schema.json and survive disk persistence
// without recreating or altering existing project identities.
// Technical description: creates temporary project roots, exercises ProjectRegistry configuration read/write and schema validation,
// verifies default comment_language="en", and confirms invalid field shapes are rejected.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ProjectRegistry,
  buildProjectConfiguration,
  readProjectConfiguration,
  writeProjectConfiguration,
  validateProject
} from "../../src/modules/projects/project-registry.js";

test("validates and round-trips all extended project configuration fields in .forge/runtime/project.json", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-project-config-roundtrip-"));
  try {
    const registry = new ProjectRegistry();
    const initialConfig = {
      name: "Dự Án Bán Hàng",
      description: "E-commerce order management platform",
      author: "NodeForge Team",
      git_url: "https://example.com/org/du-an-ban-hang.git",
      default_branch: "main",
      language: "javascript",
      package_manager: "npm",
      commands: {
        test: "npm test",
        lint: "npm run lint",
        build: "npm run build",
        dev: "npm run dev"
      },
      default_agents: {
        architecture_manager: "claude-opus",
        sprint_leader: "claude-sonnet",
        coder: "claude-sonnet",
        reviewer: "claude-opus"
      },
      watch: {
        include: ["src/**", "schemas/**"],
        exclude: ["node_modules/**", ".git/**"]
      },
      tags: ["ecommerce", "sales", "vietnam"],
      homepage_url: "https://example.com/du-an-ban-hang",
      docs_url: "https://example.com/du-an-ban-hang/docs"
    };

    const projectId = await registry.getOrCreate(projectRoot, { config: initialConfig });
    assert.equal(projectId, "du-an-ban-hang");

    const loaded = await readProjectConfiguration(projectRoot);
    assert.equal(loaded.project_id, "du-an-ban-hang");
    assert.equal(loaded.name, initialConfig.name);
    assert.equal(loaded.description, initialConfig.description);
    assert.equal(loaded.author, initialConfig.author);
    assert.equal(loaded.root, projectRoot);
    assert.equal(loaded.git_url, initialConfig.git_url);
    assert.equal(loaded.default_branch, initialConfig.default_branch);
    assert.equal(loaded.language, initialConfig.language);
    assert.equal(loaded.package_manager, initialConfig.package_manager);
    assert.deepEqual(loaded.commands, initialConfig.commands);
    assert.equal(loaded.comment_language, "en");
    assert.deepEqual(loaded.default_agents, initialConfig.default_agents);
    assert.deepEqual(loaded.watch, initialConfig.watch);
    assert.deepEqual(loaded.tags, initialConfig.tags);
    assert.equal(loaded.homepage_url, initialConfig.homepage_url);
    assert.equal(loaded.docs_url, initialConfig.docs_url);

    const updated = await writeProjectConfiguration(projectRoot, {
      description: "Updated description",
      comment_language: "vi",
      commands: {
        test: "node --test",
        lint: "npx eslint .",
        build: "npm run build:prod",
        dev: "npm run dev:watch"
      },
      tags: ["ecommerce", "updated"]
    });

    assert.equal(updated.project_id, "du-an-ban-hang");
    assert.equal(updated.comment_language, "vi");
    assert.equal(updated.description, "Updated description");

    const rawOnDisk = JSON.parse(await readFile(join(projectRoot, ".forge", "runtime", "project.json"), "utf8"));
    assert.equal(rawOnDisk.project_id, "du-an-ban-hang");
    assert.equal(rawOnDisk.comment_language, "vi");
    assert.deepEqual(rawOnDisk.commands, updated.commands);
    assert.deepEqual(rawOnDisk.default_agents, initialConfig.default_agents);

    const secondGetOrCreateId = await registry.getOrCreate(projectRoot);
    assert.equal(secondGetOrCreateId, "du-an-ban-hang");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("applies default comment_language='en' and rejects invalid extended configuration properties", async () => {
  const built = buildProjectConfiguration({
    project_id: "sample-slug",
    name: "Sample Project",
    root: "/tmp/sample-project"
  });
  assert.equal(built.comment_language, "en");

  assert.throws(
    () =>
      validateProject({
        project_id: "sample-slug",
        name: "Sample Project",
        root: "/tmp/sample-project",
        schema_version: "1.2.0",
        commands: {
          test: "npm test",
          unknown_command: "invalid"
        }
      }),
    /Invalid persisted project metadata/
  );

  assert.throws(
    () =>
      validateProject({
        project_id: "sample-slug",
        name: "Sample Project",
        root: "/tmp/sample-project",
        schema_version: "1.2.0",
        default_agents: {
          unknown_agent: "invalid"
        }
      }),
    /Invalid persisted project metadata/
  );
});
