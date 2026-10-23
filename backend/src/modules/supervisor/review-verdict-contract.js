// Parses independent Reviewer verdicts while preserving finding authority and source evidence.
import { ConfigurationError } from "../../shared/errors.js";
import { assertReviewFindingGuidance } from "./review-finding-guidance.js";
import { decodeReviewExchange } from "./review-agent-exchange.js";

// Accepts only a structured verdict, never treating free-form praise as approval.
export function parseReviewVerdict(text, options = {}) {
  let value;
  try { value = JSON.parse(extractVerdictJson(text)); }
  catch (error) { throw reviewError("REVIEW_VERDICT_INVALID", `Reviewer returned invalid JSON: ${error.message}`); }
  if (value?.kind) {
    if (!options.exchangeRequest) throw reviewError("REVIEW_VERDICT_INVALID", "A structured review result requires its Node-issued request.");
    try { value = decodeReviewExchange(value, options.exchangeRequest); }
    catch (error) { throw reviewError("REVIEW_VERDICT_INVALID", `Review exchange rejected: ${error.message}`); }
  }
  if (!["approved", "request_changes"].includes(value?.verdict) || !Array.isArray(value.findings)) throw reviewError("REVIEW_VERDICT_INVALID", "Reviewer returned an invalid verdict or findings.");
  assertReviewFindingGuidance(value, options);
  if (value.verdict === "request_changes" && !value.findings.length && !(value.adjudications ?? []).some((item) => ["retain", "refine", "reopen"].includes(item.decision))) throw reviewError("REVIEW_VERDICT_INVALID", "Requested changes require findings or a retained adjudication.");
  if (value.exchange_response) options.onExchangeResponse?.(value.exchange_response);
  return { verdict: value.verdict, findings: value.findings, adjudications: value.adjudications ?? [] };
}

// Extracts one JSON object from an SDK response that may wrap it in prose or a fenced block.
function extractVerdictJson(text) {
  const source = String(text ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  if (!source) throw new Error("empty reviewer response");
  try { JSON.parse(source); return source; } catch (error) { if (!error) throw new Error("invalid JSON"); }
  const candidates = [];
  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    const end = matchingObjectEnd(source, start);
    if (end < 0) continue;
    const candidate = source.slice(start, end + 1);
    try { const value = JSON.parse(candidate); if (value && typeof value === "object") candidates.push({ candidate, value }); } catch (error) { if (!error) throw new Error("invalid JSON candidate"); }
  }
  const verdict = candidates.find(({ value }) => typeof value.kind === "string")
    ?? candidates.find(({ value }) => typeof value.verdict === "string" && Array.isArray(value.findings));
  if (verdict) return verdict.candidate;
  throw new Error("no valid verdict object found");
}

// Finds the closing brace for one JSON object while respecting quoted strings.
function matchingObjectEnd(source, start) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

// Labels malformed Reviewer output without treating it as a code finding.
function reviewError(code, message) { return Object.assign(new ConfigurationError(message), { code }); }
