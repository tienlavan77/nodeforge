/**
 * Keeps purpose-comment editorial advice consistent across implementation tools and
 * agent review guidance. Shared text and normalized counts help authors explain
 * business intent without turning preferred lengths into additional edit gates.
 */
import { normalizePurposeComment } from "../modules/index/parser/purpose-comments.js";

/** Supplies the approved editorial targets to authors and reviewers from one source. */
export const PURPOSE_COMMENT_GUIDANCE = [
  "Purpose-comment editorial targets (advisory):",
  "| Comment kind | Target words |",
  "| --- | --- |",
  "| Simple function | 15–50 |",
  "| Ordinary function | 30–100 |",
  "| Complex function | 80–180 |",
  "| File/module | 60–180 |",
  "Count non-empty whitespace-separated units after normalization; comment delimiters and decorative prefixes do not count. For Vietnamese this is a technical counting convention, not linguistic word segmentation.",
  "Length observations are warnings or review guidance only. Short but meaningful comments and longer comments with a reason remain acceptable; length must never reject an edit or expand the existing new-code comment gate.",
  "For new files and new functions/symbols only, describe business purpose and technical description. Do not require summaries on existing code or rewrite historical comments.",
  "Write each comment entirely in English or entirely in Vietnamese; technical identifiers, tags, paths and technical terms are allowed. Never include secrets."
].join("\n");

/**
 * Counts normalized whitespace units for optional editorial feedback while leaving
 * comment presence and language enforcement independent of the preferred lengths.
 */
export function countPurposeCommentWords(raw = "") {
  return normalizePurposeComment(raw).split(/\s+/).filter(Boolean).length;
}
