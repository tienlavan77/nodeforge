import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Load deployment settings without overwriting variables explicitly supplied by the shell.
// Priority: NODEFORGE_ENV_FILE (explicit) > config/.env (canonical) > .nodeforge/env (legacy)
export function loadNodeforgeEnv() {
  if (process.env.NODEFORGE_ENV_FILE) {
    const forced = process.env.NODEFORGE_ENV_FILE;
    if (existsSync(forced)) {
      for (const line of readFileSync(forced, "utf8").split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match || match[1].startsWith("#") || process.env[match[1]] !== undefined) continue;
        process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
      }
    }
    return forced;
  }
  for (const filePath of [join(process.cwd(), "config", ".env"), join(process.cwd(), ".nodeforge", "env")]) {
    if (!existsSync(filePath)) continue;
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1].startsWith("#") || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
    return filePath;
  }
  return join(process.cwd(), "config", ".env");
}
