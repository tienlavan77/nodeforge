// Shared RFC 7396 JSON merge patch behavior for conversation plan revisions.
// Business purpose: AM may propose an updated Architecture Plan as a partial patch
// instead of a full document; Node must merge it deterministically against the
// retained canonical source before validating, locking a revision and rendering.
// Technical description: implements RFC 7396 semantics — an object value merges
// recursively, a null value deletes the matching key, any other value replaces
// the key, arrays and scalars are replaced wholesale, and key order never
// affects the result because output is canonically sorted. The same module is
// reused by every plan-update path so merge behavior stays identical across
// planning, governance and handoff consumers.
import { decisionError } from "../modules/governance/architecture-owner-decisions.js";

// Applies one RFC 7396 merge patch to an immutable target value and returns the merged result.
export function applyRfc7396MergePatch(target, patch) {
  if (patch === null) return null;
  if (!isPlainObject(patch)) {
    // A non-object, non-null patch replaces the target entirely, matching RFC 7396.
    return structuredClone(patch);
  }
  const base = isPlainObject(target) ? target : {};
  const merged = {};
  for (const key of Object.keys(base)) {
    if (Object.hasOwn(patch, key) && patch[key] === null) continue;
    merged[key] = structuredClone(base[key]);
  }
  for (const key of Object.keys(patch)) {
    if (patch[key] === null) continue;
    if (Array.isArray(patch[key]) || Array.isArray(base[key]) || !isPlainObject(patch[key]) || !isPlainObject(base[key])) {
      merged[key] = structuredClone(patch[key]);
      continue;
    }
    merged[key] = applyRfc7396MergePatch(base[key], patch[key]);
  }
  return sortJsonValue(merged);
}

// Freezes one value deeply so a merged base can never be mutated by later steps.
export function deepFreezeJson(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreezeJson(child);
  }
  return value;
}

// Classifies JSON object values so arrays and primitives never take the recursive merge path.
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

// Sorts object keys recursively so merge output is stable regardless of input order.
function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key])]));
  return value;
}

// Rejects ambiguous patch shapes before they can reach the merge engine.
export function validateRfc7396PatchShape(patch) {
  if (!isPlainObject(patch)) throw decisionError("ARCHITECTURE_PLAN_PATCH_INVALID", "A plan patch must be a JSON object.");
  if (hasNullRootValue(patch)) throw decisionError("ARCHITECTURE_PLAN_PATCH_INVALID", "A root plan field cannot be removed by null; required plan fields must carry values.");
  return patch;
}

// Root null deletion is ambiguous for required fields, so only nested nulls are valid deletions.
function hasNullRootValue(patch) {
  return Object.values(patch).some((value) => value === null);
}
