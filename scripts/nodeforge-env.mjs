import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Load deployment settings without overwriting variables explicitly supplied by the shell.
export function loadNodeforgeEnv() {
  const filePath = process.env.NODEFORGE_ENV_FILE ?? join(process.cwd(), ".nodeforge", "env");
  if (!existsSync(filePath)) return filePath;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith("#") || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return filePath;
}
