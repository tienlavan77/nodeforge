// Extracts the Architecture question payload without treating progress commentary as an owner decision.
import { decisionError, validateArchitectureQuestions } from "./architecture-owner-decisions.js";

// Accepts a single JSON answer, including a fenced final answer after repository discovery commentary.
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
