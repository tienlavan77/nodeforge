/** Shares the typed review verification request between agent prompts, tool schemas
 * and Node dispatch. Source identity and test selection stay explicit; narrative
 * requests never trigger commands or transfer finding acceptance authority. */
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import { VERIFICATION_RUNNER_INSTRUCTIONS } from "./verification-runner-environment.js";

const require = createRequire(import.meta.url);
export const reviewVerificationRequestSchema = require("../../../../schemas/governance/agent-exchange-payload.schema.json").$defs.verification_request;
const validate = new Ajv2020({ allErrors: true, strict: false }).compile({ type: "array", minItems: 1, maxItems: 8, items: reviewVerificationRequestSchema });

/** Rejects unknown tests, findings and revisions before a request can run. The
 * recorded artifact fixes source and dependencies; agents request a supported runner. */
export function assertReviewVerificationRequests(requests, { artifact, findingIds, criterionIds } = {}) {
  if (!validate(requests)) throw invalid(`Invalid verification_requests: ${JSON.stringify(validate.errors)}.`);
  if (!artifact || artifact.status !== "passed" || artifact.pre_commit === true || !artifact.commit_sha) throw invalid("Review verification requires a passed committed artifact.");
  for (const request of requests) {
    if (["artifact_id", "commit_sha", "source_revision"].some((key) => request[key] !== artifact[key])) throw invalid("Verification request differs from the reviewed artifact, commit or source revision.");
    if (request.test_paths.some((path) => path.split("/").some((part) => !part || part === "." || part === ".."))) throw invalid("Verification tests must use canonical project-relative paths.");
    if (findingIds && request.finding_ids.some((id) => !findingIds.includes(id))) throw invalid("Verification request names an unknown finding.");
    if (criterionIds && request.criterion_ids.some((id) => !criterionIds.includes(id))) throw invalid("Verification request names an unknown acceptance criterion.");
  }
  return requests;
}

/** Gives Coder and Reviewer one transport contract for an evidence-only wait,
 * keeping prose requests from accidentally becoming another implementation round. */
export function reviewVerificationInstructions() {
  return VERIFICATION_RUNNER_INSTRUCTIONS + ' EVIDENCE-ONLY VERIFICATION: when a specific focused test must run on the reviewed commit, use typed verification_requests, never a prose-only request to SL or repeated pre-commit run_check. Each request is {finding_ids:["REV-1"],criterion_ids:["AC-1"],test_paths:["backend/tests/unit/example.test.js"],scope:"ticket|regression",reason:"concrete coverage gap",artifact_id,commit_sha,source_revision}; copy all identity fields from the current passed review artifact. scope=ticket means required acceptance coverage; scope=regression requires a concrete relation and baseline attribution for failures. Use only exact supported test files, not shell commands or globs. Reviewer returns verdict=verification_required with findings:[], adjudications:[] (shared finding_updates:[]) and verification_requests; finding_ids may be [] for an initial criterion coverage gap. Node runs checks using the original recorded environment and returns durable receipts to Reviewer before any final verdict. Existing findings remain open pending Reviewer adjudication. Coder includes verification_requests inside the matching respond_to_review response, with its existing finding_id in finding_ids. Node completes this evidence request before the next review. An implementation defect uses request_changes and actionable repair guidance. New receipt evidence is not a new commit or replacement report. Do not repeat an identical verification request once its receipt is supplied; read its exact output and decide, or name distinct missing evidence.';
}

/** Keeps malformed intent in the response-correction path instead of launching a Coder repair. */
function invalid(message) { return Object.assign(new Error(message), { code: "REVIEW_VERDICT_INVALID" }); }
