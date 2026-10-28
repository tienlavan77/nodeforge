// Keeps the Codex logger API while sharing the result-only terminal contract
// used by other providers; raw item events and idle heartbeats stay silent.
import { createSdkTerminalLog } from "./sdk-terminal-log.js";

/** Binds Codex's provider identity to the shared, credential-redacted summary
 * logger without changing how callers forward SDK events or close sessions. */
export function createCodexSdkLog(options) {
  return createSdkTerminalLog({ ...options, profile: { ...options.profile, provider: "codex" } });
}
