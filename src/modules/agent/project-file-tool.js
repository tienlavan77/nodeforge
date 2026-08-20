import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { ConfigurationError } from "../../shared/errors.js";

const SECRET_PATH = /(^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:key|pem|crt|pfx|keystore))$/i;

export function createProjectFileTool({ projectRoot } = {}) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) throw new ConfigurationError("Project file tool requires a project root.");
  const root = resolve(projectRoot);

  return Object.freeze({ writeFile: safeWriteFile, writeFromQuery });

  async function writeFromQuery(query) {
    const match = String(query ?? "").match(/(?:create|write)\s+([^\s]+)(?:\s+with\s+(.+))?/i);
    if (!match) return null;
    const path = match[1];
    const content = match[2]?.replace(/^['"]|['"]$/g, "") ?? "hello\n";
    return safeWriteFile({ path, content });
  }

  async function safeWriteFile({ path, content } = {}) {
    if (typeof path !== "string" || path.length === 0 || typeof content !== "string") throw new ConfigurationError("writeFile requires a path and string content.");
    const absolute = resolve(root, path);
    const rel = relative(root, absolute).split(sep).join("/");
    if (isAbsolute(path) || rel.startsWith("..") || rel === "" || SECRET_PATH.test(rel) || rel.startsWith(".forge/")) {
      throw new ConfigurationError("Refusing unsafe or secret project path.");
    }
    await mkdir(resolve(absolute, ".."), { recursive: true });
    await writeFile(absolute, content, { encoding: "utf8", mode: 0o600 });
    return Object.freeze({ path: rel, bytes: Buffer.byteLength(content) });
  }
}
