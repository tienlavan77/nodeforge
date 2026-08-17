import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ensureForgeLayout } from "../../infrastructure/filesystem/forge-layout.js";
import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const projectSchema = require("../../../schemas/project/project.schema.json");
const PROJECT_FILE = "project.json";

export function createProjectId() {
  return `PROJECT-${randomUUID()}`;
}

export class ProjectRegistry {
  #createId;
  #schemaVersion;

  constructor({ createId = createProjectId, schemaVersion = "1.2.0" } = {}) {
    this.#createId = createId;
    this.#schemaVersion = schemaVersion;
  }

  async getOrCreate(projectRoot) {
    const root = resolveProjectRoot(projectRoot);
    const { runtimeDir } = await ensureForgeLayout(root);
    const projectFile = join(runtimeDir, PROJECT_FILE);

    try {
      const project = await readProject(projectFile);
      validateProject(project);
      return project.project_id;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const project = {
      project_id: this.#createId(),
      name: basename(root),
      root,
      forge_dir: ".forge",
      schema_version: this.#schemaVersion
    };
    validateProject(project);

    try {
      await writeFile(projectFile, `${JSON.stringify(project, null, 2)}\n`, { flag: "wx" });
      return project.project_id;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readProject(projectFile);
      validateProject(existing);
      return existing.project_id;
    }
  }
}

export async function getProjectId(projectRoot, options) {
  return new ProjectRegistry(options).getOrCreate(projectRoot);
}

async function readProject(projectFile) {
  return JSON.parse(await readFile(projectFile, "utf8"));
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
