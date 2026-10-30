/** Defines Coder file authority across the current project. Ticket manifests
 * describe evidence and changed files rather than filesystem permissions.
 * Canonical relative paths keep every operation inside the project, while Git
 * repository metadata remains owned by Git services instead of file tools. */

/** Recognizes files Coder may inspect or mutate independently of ticket path
 * hints, documentation roles, hidden-file conventions and dependency ignores.
 * Callers still check real filesystem objects to prevent symlink escapes. */
export function isCoderProjectPath(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\\")
    && [...path].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    && path.split("/").every((part) => part && part !== "." && part !== ".." && part !== ".git");
}
