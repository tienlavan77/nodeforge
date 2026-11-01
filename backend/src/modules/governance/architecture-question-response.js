// Extracts the Architecture question payload without treating progress commentary as an owner decision.
import { decisionError, validateArchitectureQuestions } from "./architecture-owner-decisions.js";

// Business purpose: extracts a trailing unfenced JSON object when the Architecture Manager emits repository discovery commentary before its final JSON answer without wrapping it in a code fence.
// Technical description: scans for a top-level opening brace whose suffix to the end of text parses as a JSON object while ensuring the preceding commentary is plain text without fences or another JSON payload.
function extractTrailingUnfencedJson(text) {
  const inlineFence = /^(?:[\s\S]*?\r?\n)?```(?:json)?[ \t]+(\{[\s\S]*\})[ \t]*```$/i.exec(text);
  if (inlineFence) return inlineFence[1].trim();
  if (text.startsWith("{") || !text.endsWith("}") || text.includes("```")) return text;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const idx = text.indexOf("{", searchFrom);
    if (idx < 0) break;
    const prefix = text.slice(0, idx).trim();
    try {
      const parsed = JSON.parse(text.slice(idx));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // eslint-disable-next-line no-silent-catch -- Non-JSON prefix confirms the commentary before the JSON object is prose.
        try { JSON.parse(prefix); return text; } catch { return text.slice(idx); }
      }
    // eslint-disable-next-line no-silent-catch -- Probe continues scanning until the outer JSON object boundary is reached.
    } catch { /* continue scanning for outer object start */ }
    searchFrom = idx + 1;
  }
  return text;
}

// Accepts a single JSON answer, including a fenced or unfenced final answer after repository discovery commentary.
export function parseArchitectureQuestions(raw) {
  const text = String(raw ?? "").trim();
  const fences = [...text.matchAll(/^```([^\r\n]*)\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gm)];
  let payload = text;
  if (fences.length) {
    const [fence] = fences;
    if (fences.length !== 1 || !["", "json"].includes(fence[1].trim().toLowerCase()) || text.slice(fence.index + fence[0].length).trim()) {
      throw decisionError("ARCHITECTURE_QUESTIONS_INVALID", "Architecture must return one unambiguous JSON question response.");
    }
    payload = fence[2].trim();
  } else {
    payload = extractTrailingUnfencedJson(text);
  }
  let analysis;
  try { analysis = JSON.parse(payload); }
  catch (error) {
    const failure = decisionError("ARCHITECTURE_QUESTIONS_INVALID", "Architecture returned malformed question JSON. Retry /plan; no owner choices or plan were saved.");
    failure.cause = error;
    throw failure;
  }
  return validateArchitectureQuestions(analysis?.questions);
}
