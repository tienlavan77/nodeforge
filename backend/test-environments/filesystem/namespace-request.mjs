// Constrains retained-runner requests to the current Node binary and canonical
// project directories so fixture setup privileges never execute client commands.
import { relative, sep } from "node:path";

// Validates before spawning the unprivileged verifier, including symlink escape
// checks on its cwd. Status and shutdown are handled separately by the server.
export function validateNamespaceRequest(request, repository, canonical) {
  if (request.action !== "run" || !Array.isArray(request.argv) || request.argv.length < 2
    || request.argv.some(value => typeof value !== "string" || value.includes("\0"))
    || request.argv[0] !== process.execPath || typeof request.cwd !== "string") {
    throw new Error("VERIFICATION_BLOCKED: expected an explicit Node verification command");
  }
  const local = relative(canonical(repository), canonical(request.cwd));
  if (local === ".." || local.startsWith(`..${sep}`) || local.startsWith(sep)) {
    throw new Error("VERIFICATION_BLOCKED: verification cwd escapes the project");
  }
}
