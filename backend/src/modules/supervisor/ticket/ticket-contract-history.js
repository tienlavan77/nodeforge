// Locates immutable approved contract bytes inherited through a Sprint's evolving source history.
import { createHash } from "node:crypto";

// Proves an approval checksum in the retained baseline ancestry without replacing its identity.
export async function findTicketContractHistory({ rootGit, baseline, path, sha256 }) {
  const commits = (await rootGit.run(["log", "--format=%H", baseline, "--", `:(literal)${path}`])).trim().split("\n").filter(Boolean);
  for (const commit of commits) {
    const content = await rootGit.fileAt(commit, path);
    if (content !== null && createHash("sha256").update(content).digest("hex") === sha256) return commit;
  }
  return null;
}
