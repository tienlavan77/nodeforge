import { ConfigurationError } from "../../shared/errors.js";
import { createFileService } from "../../infrastructure/filesystem/file-service.js";

export function createProjectFileTool({ projectRoot, fileService } = {}) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) throw new ConfigurationError("Project file tool requires a project root.");
  const files = fileService ?? createFileService({ projectRoot });

  return Object.freeze({ writeFile: files.writeFile, writeFromQuery });

  async function writeFromQuery(query) {
    const match = String(query ?? "").match(/(?:create|write)\s+([^\s]+)(?:\s+with\s+(.+))?/i);
    if (!match) return null;
    const path = match[1];
    const content = match[2]?.replace(/^['"]|['"]$/g, "") ?? "hello\n";
    return files.writeFile({ path, content });
  }
}
