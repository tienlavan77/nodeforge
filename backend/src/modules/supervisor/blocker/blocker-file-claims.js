// Supplies current Node-owned file-claim metadata so blocker decisions do not rely on stale competing-owner reports.
import { statePath } from "../../../infrastructure/filesystem/forge-paths.js";
import { createHash } from "node:crypto";

// Reads only project-scoped claim records for the investigation's referenced source paths, never transferring ownership.
export async function inspectBlockerFileClaims({ job, fileService }) {
  if (!fileService?.readFile) return [];
  const refs = [...(job.evidence ?? []), ...(job.history ?? []).flatMap((entry) => entry.disposition?.evidence ?? []), ...(job.resolution?.evidence ?? [])];
  const paths = [...new Set(refs.map((entry) => typeof entry === "string" ? entry : entry?.path ?? entry?.reference)
    .map((path) => typeof path === "string" ? path.replace(/:\d+(?::\d+)?$/, "") : path)
    .filter((path) => typeof path === "string" && path.length <= 1024 && !path.startsWith("/") && !path.split("/").includes("..")))].slice(-16);
  const scope = createHash("sha256").update(job.request.project_id).digest("hex");
  const claims = [];
  for (const path of paths) {
    const key = createHash("sha256").update(path).digest("hex");
    let claim = null;
    try {
      claim = JSON.parse(await fileService.readFile({ path: `${statePath()}/ticket-changes/${scope}/claims/${key}.json` }));
      if (!claim || claim.path !== path || typeof claim.task_id !== "string" || !claim.task_id
        || Object.hasOwn(claim, "claim_id") && (typeof claim.claim_id !== "string" || !claim.claim_id)) throw new Error("Blocker file-claim metadata has an invalid identity.");
    }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    claims.push({ path, owner_task_id: claim?.task_id ?? null, claim_id: claim?.claim_id ?? null });
  }
  return claims;
}
