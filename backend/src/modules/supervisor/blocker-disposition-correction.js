// Reuses retained recovery responses and stops unchanged validation failures without imposing an agent call quota.
import { createHash } from "node:crypto";
import { discoveryAssignment } from "./blocker-discovery-checkpoint.js";

// Reads a retained JSON disposition, including a single fenced response, without treating surrounding text as authority.
function retainedDisposition(text) {
  const trimmed = String(text).trim();
  const fences = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map((match) => match[1].trim()).filter(Boolean);
  return JSON.parse(fences.length === 1 ? fences[0] : trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
}

// Revalidates same-assignment evidence after a validator fix before making another provider request.
export async function salvagePersistedDisposition({ work, job, update, checkDisposition }) {
  const prior = (job.disposition_attempts ?? []).findLast((attempt) => attempt.stage === job.stage && (!attempt.assignment_id || attempt.assignment_id === discoveryAssignment(job))
    && attempt.status === "rejected" && attempt.response?.text);
  if (!prior?.response?.text) return null;
  let verified;
  try { verified = await checkDisposition(retainedDisposition(prior.response.text), job, { retained: true }); }
  catch (error) { return error && null; }
  const saved = await update(work, (current, ledger) => {
    ledger.calls = Math.max(0, ledger.calls - 1);
    const target = (current.disposition_attempts ?? []).findLast((attempt) => attempt.stage === current.stage && attempt.status === "rejected");
    if (target) { target.status = "received"; delete target.validation_errors; }
  });
  return saved ? verified : null;
}

// Detects the same invalid fields on unchanged source even when summaries are rewritten or the API restarts.
export function repeatedDispositionCorrection(job, feedback) {
  const attempt = job.disposition_attempts?.at(-1);
  if (!attempt?.response?.text) return false;
  let response;
  try { response = retainedDisposition(attempt.response.text); }
  catch (error) { response = { unparsed: attempt.response.sha256, error: error.message }; }
  const errors = feedback.map(({ path, reason, received }) => {
    const parts = (path ?? "").split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    const value = parts.reduce((node, part) => node?.[part], response);
    return { path, reason, value: received ?? value ?? null };
  }).sort((a, b) => String(a.path).localeCompare(String(b.path)));
  const fingerprint = createHash("sha256").update(JSON.stringify({ assignment: attempt.assignment_id ?? discoveryAssignment(job),
    stage: job.stage, source: job.ticket_progress?.evidence_sha256 ?? null, errors })).digest("hex");
  const repeated = job.disposition_attempts.slice(0, -1).some((entry) => entry.correction_fingerprint === fingerprint);
  attempt.correction_fingerprint = fingerprint;
  return repeated;
}
