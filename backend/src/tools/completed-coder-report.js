// Replays completed ticket reports without overwriting their immutable explanation or injecting fresh default fields.
import { isDeepStrictEqual } from "node:util";

// Resolves an existing report against the exact verified revision before normalizing any new draft defaults.
export async function readCompletedCoderReport({ reviewFindings, artifact, input }) {
  if (!reviewFindings?.load) return null;
  const history = await reviewFindings.load();
  const saved = (history.coder_reports ?? []).find((entry) => entry.artifact_id === artifact.artifact_id);
  if (!saved) return null;
  if (saved.review_commit_sha !== artifact.commit_sha || saved.source_revision !== artifact.source_revision || saved.manifest_sha !== artifact.manifest_sha)
    throw failure("The completed report belongs to a different verification identity.");
  for (const [field, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(saved.report, field) || !matchesRecorded(value, saved.report[field]))
      throw failure(`Completed report field ${field} is immutable. Use respond_to_review for new finding responses on this verified revision; report_done({}) replays the existing report.`);
  }
  return structuredClone(saved.report);
}

// Accepts an identical partial replay while rejecting changed, added or reordered report data.
function matchesRecorded(value, recorded) {
  if (Array.isArray(value)) return Array.isArray(recorded) && value.length === recorded.length
    && value.every((entry, index) => matchesRecorded(entry, recorded[index]));
  if (value && typeof value === "object") return recorded && typeof recorded === "object" && !Array.isArray(recorded)
    && Object.keys(value).every((key) => Object.hasOwn(recorded, key) && matchesRecorded(value[key], recorded[key]));
  return isDeepStrictEqual(value, recorded);
}

// Preserves the report conflict diagnostic while naming the supported evidence-only response path.
function failure(message) { return Object.assign(new Error(message), { code: "CODER_REPORT_CONFLICT" }); }
