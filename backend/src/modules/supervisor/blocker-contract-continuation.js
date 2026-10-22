// Verifies that a retained Architecture decision still governs a resumed ticket without inventing a new AM verdict.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sameExecutionPlan, validExecutionBasis } from "../projects/ticket-execution-identity.js";

// Compares delivery policy amendments without erasing changes to acceptance, permissions or implementation scope.
function reviewPolicyContent(value, field = "") {
  if (Array.isArray(value)) return value.map((item) => reviewPolicyContent(item, field));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reviewPolicyContent(item, key)]));
  if (typeof value !== "string" || !["objective", "approach"].includes(field)) return value;
  return value.replaceAll("with at most two revision/re-review cycles after initial review", "with no fixed limit on revision/re-review cycles")
    .replaceAll("; exhausted revisions remain blocked or failed, never implicitly accepted", "");
}

// Loads exact immutable plan bytes named by a Node scheduling basis before comparing inherited contract scope.
async function readPlan(fileService, basis) {
  const bytes = await fileService.readFile({ path: basis.plan_path });
  if (createHash("sha256").update(bytes).digest("hex") !== basis.plan_sha256) return null;
  const plan = JSON.parse(bytes);
  return plan.project_id === basis.project_id && plan.sprint_id === basis.sprint_id && plan.plan_id === basis.plan_id
    && plan.revision === basis.plan_revision ? plan : null;
}

// Allows Node to reuse a technical AM contract only for the same ticket and unchanged approved business scope.
export async function contractContinuation({ record, binding, fileService }) {
  const before = record.sprint_basis, after = binding.sprint_basis;
  if (!record.execution_id || !binding.execution_id || record.project_id !== binding.project_id || record.task_id !== binding.task_id
    || !validExecutionBasis(before) || !validExecutionBasis(after) || before.project_id !== binding.project_id
    || after.project_id !== binding.project_id || before.sprint_id !== after.sprint_id || before.plan_id !== after.plan_id) return null;
  if (sameExecutionPlan(before, after)) return { reason: "same_approved_plan", execution_id: binding.execution_id, sprint_basis: after };
  if (after.plan_revision <= before.plan_revision) return null;
  const previous = await readPlan(fileService, before), current = await readPlan(fileService, after);
  if (!previous || !current || !previous.source_sha256 || previous.source_sha256 !== current.source_sha256
    || previous.source_path !== current.source_path || previous.proposal_id !== current.proposal_id
    || !previous.content.tickets.includes(binding.task_id) || !current.content.tickets.includes(binding.task_id)
    || !isDeepStrictEqual(reviewPolicyContent(previous.content), reviewPolicyContent(current.content))) return null;
  return { reason: "review_policy_only_amendment", execution_id: binding.execution_id, sprint_basis: after };
}
