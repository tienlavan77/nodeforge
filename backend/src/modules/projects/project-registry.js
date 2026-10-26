import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { captureRoot, assertRoot, prepareStorage } from "./project-filesystem-safety.js";
import { verifyProjectIdentity, inspectProjectStorage, readProjectIdentity, prepareProjectLayout } from "./project-identity-safety.js";
import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../../schemas/core/common.schema.json");
const projectSchema = require("../../../../schemas/project/project.schema.json");
const PROJECT_FILE = "project.json";

export function createProjectId() {
  return `PROJECT-${randomUUID()}`;
}

export class ProjectRegistry {
  #createId;
  #schemaVersion;

  constructor({ createId = createProjectId, schemaVersion = "1.2.0", fileService } = {}) {
    this.#createId = createId;
    this.#schemaVersion = schemaVersion;
    this.fileService = fileService;
  }

  async getOrCreate(projectRoot, { expectedProjectId, strictIdentity = false, rootBinding } = {}) {
    const root = resolveProjectRoot(projectRoot);
    const binding = rootBinding ?? await captureRoot(root);
    await assertRoot(binding);
    await inspectProjectStorage(binding);
    const projectFile = join(root, ".forge", "runtime", PROJECT_FILE);

    try {
      const project = await readProject(projectFile);
      validateProject(project);
      if (expectedProjectId && project.project_id !== expectedProjectId) throw new ConfigurationError("Catalog and per-root project identity differ.");
      if (strictIdentity) await verifyProjectIdentity(binding, project);
      await prepareProjectLayout(binding);
      return project.project_id;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (expectedProjectId) throw new ConfigurationError("Catalog identity is missing from the project root.");
    const project = {
      project_id: this.#createId(),
      name: basename(root),
      root,
      forge_dir: ".forge",
      schema_version: this.#schemaVersion
    };
    validateProject(project);
    await assertRoot(binding);
    await prepareStorage(binding);
    await inspectProjectStorage(binding);

    try {
      if (this.fileService?.atomicCreate) await this.fileService.atomicCreate({ path: projectFile.slice(root.length + 1), content: `${JSON.stringify(project, null, 2)}\n` });
      else await writeFile(projectFile, `${JSON.stringify(project, null, 2)}\n`, { flag: "wx" });
      if (strictIdentity) await verifyProjectIdentity(binding, project);
      await prepareProjectLayout(binding);
      return project.project_id;
    } catch (error) {
      if (error.code !== "EEXIST" && error.code !== "FILE_ALREADY_EXISTS") throw error;
      const existing = await readProject(projectFile);
      validateProject(existing);
      if (strictIdentity) await verifyProjectIdentity(binding, existing);
      await prepareProjectLayout(binding);
      return existing.project_id;
    }
  }
}

export async function getProjectId(projectRoot, options) {
  return new ProjectRegistry(options).getOrCreate(projectRoot);
}

async function readProject(projectFile) {
  return readProjectIdentity(projectFile);
}

function validateProject(project) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(projectSchema);
  const validate = ajv.getSchema(projectSchema.$id);
  if (!validate(project)) {
    throw new ConfigurationError(`Invalid persisted project metadata: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  }
}

function resolveProjectRoot(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new ConfigurationError("A project root is required.");
  }
  return resolve(projectRoot);
}
