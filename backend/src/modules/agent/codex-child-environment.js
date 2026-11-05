// Child Codex environment construction removes inherited session identity and normalizes executable lookup.
import process from "node:process";
import { prependNodeBin } from "./node-bin-path.js";

// Business purpose: builds an isolated environment for a Codex child process without inheriting parent session identity.
// Technical description: removes nested-session markers, applies explicit overrides, strips credentials, and normalizes PATH.
export function buildCodexChildEnvironment(baseEnvironment, overrides) {
  const env = { ...(baseEnvironment && typeof baseEnvironment === "object" ? baseEnvironment : process.env) };
  for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_PERMISSION_PROFILE", "CODEX_CI", "CODEX_MANAGED_BY_NPM", "CODEX_MANAGED_PACKAGE_ROOT", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"]) delete env[name];
  if (overrides && typeof overrides === "object") Object.assign(env, overrides);
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  env.PATH = prependNodeBin(env.PATH);
  return env;
}
