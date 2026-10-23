// Serializes Forge Git mutations with ticket root commits across Control API processes.
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { createHash } from "node:crypto";
import { acquireTicketFileLock } from "./ticket-file-lock.js";

// Runs a Git mutation while holding the project-wide commit lock.
export async function withTicketProjectCommitLock({ fileService, projectId }, action) {
  const projectKey = createHash("sha256").update(projectId).digest("hex");
  const lock = await acquireTicketFileLock(fileService, `${statePath()}/ticket-root-commits/${projectKey}/commit.lock`, { attempts: 1500 });
  try { return await action(); }
  finally { await lock.release(); }
}
