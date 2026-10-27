import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { captureRoot, assertRoot, prepareStorage } from "./project-filesystem-safety.js";
import { verifyProjectIdentity, inspectProjectStorage, readProjectIdentity, prepareProjectLayout, replaceProjectIdentityAtomically } from "./project-identity-safety.js";
import {
  PROJECT_SLUG_PATTERN,
  LEGACY_PROJECT_ID_PATTERN,
  PROJECT_ID_COMPATIBILITY_PATTERN,
  RESERVED_SYSTEM_ROUTES,
  isReservedProjectRoute,
  isValidProjectId,
  normalizeNameToSlug,
  generateProjectSlug,
  isProjectSlugTaken,
  releaseProjectSlugReservation
} from "./project-slug.js";
import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../../schemas/core/common.schema.json");
const projectSchema = require("../../../../schemas/project/project.schema.json");
const PROJECT_FILE = "project.json";

const EXTENDED_PROJECT_CONFIG_KEYS = Object.freeze([
  "description",
  "author",
  "git_url",
  "default_branch",
  "default_workflow_id",
  "created_at",
  "language",
  "package_manager",
  "commands",
  "comment_language",
  "default_agents",
  "watch",
  "tags",
  "homepage_url",
  "docs_url",
  "metadata"
]);

export {
  PROJECT_SLUG_PATTERN,
  LEGACY_PROJECT_ID_PATTERN,
  PROJECT_ID_COMPATIBILITY_PATTERN,
  RESERVED_SYSTEM_ROUTES,
  isReservedProjectRoute,
  isValidProjectId,
  normalizeNameToSlug,
  generateProjectSlug
};

// Generates a project identifier: produces a URL-safe slug when given a project name or options,
// or falls back to a legacy PROJECT-<uuid> identifier when invoked without arguments.
export function createProjectId(nameOrOptions, options = {}) {
  if (typeof nameOrOptions === "string" && nameOrOptions.trim().length > 0) {
    return generateProjectSlug(nameOrOptions, options);
  }
  if (nameOrOptions && typeof nameOrOptions === "object" && !Array.isArray(nameOrOptions)) {
    const candidateName = nameOrOptions.name ?? nameOrOptions.projectName;
    if (typeof candidateName === "string" && candidateName.trim().length > 0) {
      return generateProjectSlug(candidateName, nameOrOptions);
    }
  }
  return `PROJECT-${randomUUID()}`;
}

// Normalizes and validates a project configuration object, applying schema defaults such as comment_language: "en".
// Business purpose: ensures `.forge/runtime/project.json` records carry a consistent, validated set of extended configuration fields while preserving existing identities.
// Technical description: merges optional extended configuration properties, defaults comment_language to "en" when omitted, and runs JSON Schema validation via Ajv2020.
export function buildProjectConfiguration(input = {}, { schemaVersion = "1.2.0" } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigurationError("Project configuration must be an object.");
  }
  const root = resolveProjectRoot(input.root);
  const name = typeof input.name === "string" && input.name.trim().length > 0 ? input.name : basename(root);
  const project = {
    project_id: input.project_id ?? createProjectId(name, input),
    name,
    root,
    forge_dir: input.forge_dir ?? ".forge",
    schema_version: input.schema_version ?? schemaVersion,
    comment_language: input.comment_language ?? "en"
  };
  for (const key of EXTENDED_PROJECT_CONFIG_KEYS) {
    if (key === "comment_language") continue;
    if (input[key] !== undefined) {
      project[key] = input[key];
    }
  }
  validateProject(project);
  return project;
}

export class ProjectRegistry {
  #createId;
  #schemaVersion;
  #slugScope;

  constructor({ createId = createProjectId, schemaVersion = "1.2.0", fileService } = {}) {
    this.#createId = createId;
    this.#schemaVersion = schemaVersion;
    this.#slugScope = [];
    this.fileService = fileService;
  }

  async getOrCreate(projectRoot, { expectedProjectId, strictIdentity = false, rootBinding, config = {}, existingIds, catalog, onReserved } = {}) {
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
    const desiredName = typeof config?.name === "string" && config.name.trim().length > 0 ? config.name : basename(root);
    const useSlugAllocation = this.#createId === createProjectId && !config?.project_id && Boolean(config?.name || existingIds || catalog || onReserved);
    const activeCatalog = catalog ?? (useSlugAllocation ? this.#slugScope : null);
    let generatedId = this.#createId === createProjectId
      ? (config?.project_id ?? (useSlugAllocation
        ? generateProjectSlug(desiredName, { existingIds, catalog: activeCatalog, onReserved, root, reserve: true })
        : this.#createId()))
      : this.#createId(desiredName, { existingIds, catalog: activeCatalog, onReserved, root });

    await assertRoot(binding);
    await prepareStorage(binding);
    await inspectProjectStorage(binding);

    const rejectedIds = new Set();
    for (let attempt = 0; attempt < 32; attempt += 1) {
      if (useSlugAllocation && isProjectSlugTaken(generatedId, { catalog: activeCatalog, existingIds, root })) {
        rejectedIds.add(generatedId);
        releaseProjectSlugReservation(activeCatalog, generatedId, root);
        generatedId = generateProjectSlug(desiredName, {
          existingIds: [...(existingIds ? [...existingIds] : []), ...rejectedIds],
          catalog: activeCatalog,
          onReserved,
          root,
          reserve: true
        });
      }
      const project = {
        project_id: generatedId,
        name: desiredName,
        root,
        forge_dir: config?.forge_dir ?? ".forge",
        schema_version: config?.schema_version ?? this.#schemaVersion,
        ...(config?.comment_language !== undefined ? { comment_language: config.comment_language } : {})
      };
      for (const key of EXTENDED_PROJECT_CONFIG_KEYS) {
        if (key === "comment_language") continue;
        if (config?.[key] !== undefined) project[key] = config[key];
      }
      validateProject(project);

      try {
        const serialized = `${JSON.stringify(project, null, 2)}\n`;
        if (this.fileService?.atomicCreate) await this.fileService.atomicCreate({ path: projectFile.slice(root.length + 1), content: serialized });
        else await writeFile(projectFile, serialized, { flag: "wx", mode: 0o600 });
        if (strictIdentity) await verifyProjectIdentity(binding, project);
        await prepareProjectLayout(binding);
        return project.project_id;
      } catch (error) {
        releaseProjectSlugReservation(activeCatalog, generatedId, root);
        if (error.code !== "EEXIST" && error.code !== "FILE_ALREADY_EXISTS") throw error;
        const existing = await readProject(projectFile);
        validateProject(existing);
        if (strictIdentity) await verifyProjectIdentity(binding, existing);
        await prepareProjectLayout(binding);
        return existing.project_id;
      }
    }
    throw new ConfigurationError("Unable to allocate a unique project slug after repeated collisions.");
  }

  // Reads and validates the persisted `.forge/runtime/project.json` configuration for a project root, applying schema defaults.
  // Business purpose: allows callers to inspect the full extended project configuration from disk with default `comment_language` populated.
  // Technical description: loads `.forge/runtime/project.json` through a no-follow descriptor, validates against `project.schema.json`, and fills default values.
  async readConfiguration(projectRoot) {
    const root = resolveProjectRoot(projectRoot);
    const projectFile = join(root, ".forge", "runtime", PROJECT_FILE);
    const project = await readProject(projectFile);
    validateProject(project);
    return {
      forge_dir: ".forge",
      comment_language: "en",
      ...project
    };
  }

  // Updates extended configuration fields in `.forge/runtime/project.json` without recreating or mutating `project_id` or `root`.
  // Business purpose: supports saving extended project metadata (commands, default_agents, watch, urls, tags, etc.) while guaranteeing existing project identity stability.
  // Technical description: reads the existing `project.json`, rejects attempts to alter `project_id` or `root`, merges allowed fields with default `comment_language: "en"`, validates via Ajv, and persists through a guarded atomic temporary file replacement.
  async writeConfiguration(projectRoot, updates = {}) {
    const root = resolveProjectRoot(projectRoot);
    const binding = await captureRoot(root);
    await assertRoot(binding);
    await inspectProjectStorage(binding);
    const projectFile = join(root, ".forge", "runtime", PROJECT_FILE);
    const existing = await readProject(projectFile);
    validateProject(existing);
    if (updates.project_id !== undefined && updates.project_id !== existing.project_id) {
      throw new ConfigurationError("Cannot change existing project_id when updating project configuration.");
    }
    if (updates.root !== undefined && resolve(updates.root) !== existing.root) {
      throw new ConfigurationError("Cannot change existing root when updating project configuration.");
    }
    const next = {
      ...existing,
      name: updates.name !== undefined ? updates.name : existing.name,
      comment_language: updates.comment_language ?? existing.comment_language ?? "en"
    };
    for (const key of EXTENDED_PROJECT_CONFIG_KEYS) {
      if (key === "comment_language") continue;
      if (updates[key] !== undefined) next[key] = updates[key];
    }
    validateProject(next);
    await assertRoot(binding);
    await inspectProjectStorage(binding);
    await replaceProjectIdentityAtomically(binding, projectFile, `${JSON.stringify(next, null, 2)}\n`, this.fileService);
    return next;
  }
}

export async function getProjectId(projectRoot, options) {
  return new ProjectRegistry(options).getOrCreate(projectRoot);
}

// Reads and validates a `.forge/runtime/project.json` file directly, applying schema defaults such as `comment_language: "en"`.
// Business purpose: provides a standalone helper for reading and validating extended project configuration from disk.
// Technical description: reads the JSON file via `readProjectIdentity`, validates against `project.schema.json` with `useDefaults: true`, and returns the normalized configuration object.
export async function readProjectConfiguration(projectRoot) {
  return new ProjectRegistry().readConfiguration(projectRoot);
}

// Persists updated extended project configuration fields to `.forge/runtime/project.json` while preserving existing identity.
// Business purpose: provides a standalone helper for updating extended project configuration on disk without mutating `project_id`.
// Technical description: delegates to `ProjectRegistry.prototype.writeConfiguration` to validate and write updated configuration fields.
export async function writeProjectConfiguration(projectRoot, updates, options) {
  return new ProjectRegistry(options).writeConfiguration(projectRoot, updates);
}

async function readProject(projectFile) {
  return readProjectIdentity(projectFile);
}

// Validates a project configuration object against `schemas/project/project.schema.json` and applies schema defaults.
// Business purpose: enforces strict contract compliance for all required and extended project configuration fields before persistence or admission.
// Technical description: compiles `common.schema.json` and `project.schema.json` with Ajv2020 (`useDefaults: true`) and throws `ConfigurationError` on schema violations.
export function validateProject(project) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(projectSchema);
  const validate = ajv.getSchema(projectSchema.$id);
  if (!validate(project)) {
    throw new ConfigurationError(`Invalid persisted project metadata: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  }
  return project;
}

function resolveProjectRoot(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new ConfigurationError("A project root is required.");
  }
  return resolve(projectRoot);
}
