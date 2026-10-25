// node-bin-path — single source of truth for keeping the active Node executable's
// directory first on PATH in the environments handed to SDK agent subprocesses.
// Deriving the directory from process.execPath (not a hardcoded deployment path)
// means npm, npx and pnpm launched by a gateway's Bash/shell commands resolve to
// the same Node version that runs the gateway, regardless of the host shell's
// startup files. The separator and dedup logic live here so the Claude and Codex
// gateways cannot drift apart in how they normalize PATH.
import { delimiter, dirname } from "node:path";
import process from "node:process";

// Returns a PATH string with the directory of the running Node executable placed
// first and any later duplicate of that same directory removed. A non-string
// input (missing PATH) yields just the Node directory so the result is always
// usable by a spawned shell.
export function prependNodeBin(currentPath) {
  const nodeBin = dirname(process.execPath);
  const segments = typeof currentPath === "string"
    ? currentPath.split(delimiter).filter(Boolean)
    : [];
  return [nodeBin, ...segments.filter((segment) => segment !== nodeBin)].join(delimiter);
}
