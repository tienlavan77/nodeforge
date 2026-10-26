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

/** Restores unfinished explanation fields before Node derives criterion
 * coverage. Partial retries retain prior test bindings and accumulate receipt
 * references within the same artifact family, without accepting evidence from
 * another commit, source revision or manifest. */
export async function readCoderReportDraft({ reviewFindings, artifact, input, ticket }) {
  if (!reviewFindings?.load) return input;
  const history = await reviewFindings.load();
  const drafts = history.coder_report_drafts ?? [];
  const saved = drafts.find((entry) => entry.artifact_id === artifact.artifact_id)
    ?? (artifact.supplemental_base_artifact_id ? drafts.findLast((entry) => entry.artifact_id === artifact.supplemental_base_artifact_id
      || entry.supplemental_base_artifact_id === artifact.supplemental_base_artifact_id) : null);
  if (!saved) return input;
  if (saved.review_commit_sha !== artifact.commit_sha || saved.source_revision !== artifact.source_revision || saved.manifest_sha !== artifact.manifest_sha)
    throw failure("The unfinished report belongs to a different verification identity.");
  const merged = { ...structuredClone(saved.report), ...input };
  merged.evidence = mergeReportEntries(saved.report.evidence, input.evidence, (entry) => `${entry.type}:${entry.reference}`);
  merged.acceptance_coverage = mergeReportEntries(saved.report.acceptance_coverage, input.acceptance_coverage, (entry) => criterionIdentity(entry, ticket));
  return merged;
}

/** Supplements individual draft entries without erasing previously supplied
 * paths or receipt fields when the agent corrects only one field on retry. */
function mergeReportEntries(previous = [], updates = [], identity) {
  const entries = new Map();
  for (const entry of [...previous, ...updates]) {
    const key = identity(entry);
    entries.set(key, { ...entries.get(key), ...entry });
  }
  return [...entries.values()];
}

/** Binds partial criterion corrections to the existing ticket identity across
 * stable IDs and the legacy criterion index or exact-text formats. */
function criterionIdentity(entry, ticket) {
  if (entry.criterion_id) return entry.criterion_id;
  const index = Number.isInteger(entry.criterion_index) ? entry.criterion_index : (ticket.acceptance_criteria ?? []).indexOf(entry.criterion);
  return index >= 0 ? `AC-${index + 1}` : JSON.stringify(entry);
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
