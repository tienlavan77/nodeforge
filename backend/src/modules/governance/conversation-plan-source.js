// Node-owned immutable canonical JSON source anchor for conversation-created plans.
// Business purpose: an owner creates an Architecture Plan from ordinary conversation
// without typing a path, hash or command, so Node (not the owner and never the
// Architecture Manager) must still bind each revision to a durable source snapshot.
// This anchor holds the exact canonical plan JSON inside the existing plan runtime
// area and is passed to the unchanged Markdown plan store as summary_path and
// summary_sha256, keeping the existing SUMMARY snapshot and integrity gates in force
// for approval and Sprint Leader handoff.
// Technical description: writes are create-if-absent under
// `.forge/runtime/nf/plans/<plan_id>/plan-source-r<revision>.json`; an existing
// anchor is accepted only when byte-for-byte identical, so a revision can never be
// silently re-anchored to different content. Reads verify the recorded SHA-256
// before returning bytes.
import { createHash } from "node:crypto";
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { decisionError } from "./architecture-owner-decisions.js";

const SAFE_PLAN_ID = /^PLAN-[A-Za-z0-9._-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;

// Builds the project-relative anchor path Node owns for one plan revision.
export function conversationPlanSourcePath({ planId, revision }) {
  if (!SAFE_PLAN_ID.test(planId ?? "") || !Number.isSafeInteger(revision) || revision < 1) throw decisionError("PLAN_ID_INVALID", "A canonical plan anchor needs a valid plan ID and positive revision.");
  return `${statePath()}/nf/plans/${planId}/plan-source-r${revision}.json`;
}

// Writes the canonical JSON once and returns its path plus exact-byte SHA-256.
export async function retainConversationPlanSource({ fileService, planId, revision, canonicalBytes }) {
  const path = conversationPlanSourcePath({ planId, revision });
  const sha256 = createHash("sha256").update(String(canonicalBytes)).digest("hex");
  try { await fileService.atomicCreate({ path, content: canonicalBytes }); }
  catch (error) {
    if (error.code !== "FILE_ALREADY_EXISTS") throw error;
    const existing = await fileService.readFile({ path }).catch((cause) => { throw decisionError("PLAN_SOURCE_MISSING", `Canonical plan anchor is unreadable: ${cause.code ?? cause.message}.`); });
    if (existing !== canonicalBytes) throw decisionError("PLAN_SOURCE_MISMATCH", "Canonical plan anchor already holds different bytes for this revision.");
  }
  return { path, sha256 };
}

// Reads one anchor back and refuses to return altered or missing source bytes.
export async function readConversationPlanSource({ fileService, path, sha256 }) {
  if (!SHA256.test(sha256 ?? "")) throw decisionError("PLAN_SOURCE_MISMATCH", "Canonical plan anchor needs its recorded checksum.");
  let bytes;
  try { bytes = await fileService.readFile({ path }); }
  catch (error) { throw decisionError("PLAN_SOURCE_MISSING", `Canonical plan anchor is unavailable: ${error.code ?? error.name}.`); }
  if (createHash("sha256").update(String(bytes)).digest("hex") !== sha256) throw decisionError("PLAN_SOURCE_MISMATCH", "Canonical plan anchor no longer matches its recorded checksum.");
  return bytes;
}

// Snapshots the Node-generated conversation intake record so a clarification pause has a stable source.
// Technical description: the intake record is canonical JSON describing the trigger and
// conversation, written create-if-absent under the same plan runtime area; it becomes the
// clarification session source until the first plan revision replaces it with plan JSON.
export async function retainConversationIntakeSource({ fileService, planId, intake }) {
  if (!SAFE_PLAN_ID.test(planId ?? "")) throw decisionError("PLAN_ID_INVALID", "A conversation intake anchor needs a valid plan ID.");
  const canonicalBytes = `${JSON.stringify(intake)}\n`;
  const path = `${statePath()}/nf/plans/${planId}/conversation-intake.json`;
  const sha256 = createHash("sha256").update(canonicalBytes).digest("hex");
  try { await fileService.atomicCreate({ path, content: canonicalBytes }); }
  catch (error) {
    if (error.code !== "FILE_ALREADY_EXISTS") throw error;
    const existing = await fileService.readFile({ path }).catch((cause) => { throw decisionError("PLAN_SOURCE_MISSING", `Conversation intake anchor is unreadable: ${cause.code ?? cause.message}.`); });
    if (existing !== canonicalBytes) throw decisionError("PLAN_SOURCE_MISMATCH", "Conversation intake anchor already holds different bytes; start a new planning request.");
  }
  return { path, sha256, canonicalBytes };
}
