// Archives exact Architecture plan revisions in the Coding view without changing server approval or handoff authority.

// Scopes browser-only archive preferences to the selected project.
export function codingPlanArchiveStorageKey(projectId) {
  if (typeof projectId !== "string" || !projectId.trim()) throw new Error("A project is required to archive a plan.");
  return `nodeforge:coding:architecture-plan-archives:${encodeURIComponent(projectId)}`;
}

// Identifies immutable plan bytes so a newer revision remains visible for review.
export function codingPlanArchiveKey(plan) {
  if (!plan?.plan_id || !Number.isSafeInteger(plan.revision) || plan.revision < 1 || !/^[a-f0-9]{64}$/i.test(plan.sha256 ?? "")) throw new Error("An exact plan revision is required to archive a plan.");
  return JSON.stringify([plan.plan_id, plan.revision, plan.sha256]);
}

// Reads archived identities without storing Markdown, approval decisions, or owner tokens.
export function readCodingPlanArchives(projectId, storage = globalThis.localStorage) {
  if (typeof storage?.getItem !== "function") throw new Error("Browser archive storage is unavailable.");
  const raw = storage.getItem(codingPlanArchiveStorageKey(projectId));
  if (raw === null) return [];
  const keys = JSON.parse(raw);
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) throw new Error("Saved plan archive preferences are invalid.");
  return [...new Set(keys)];
}

// Persists Archive or Restore before hiding a row, retaining preferences saved by another tab.
export function setCodingPlanArchived(projectId, plan, archived, storage = globalThis.localStorage) {
  if (typeof storage?.setItem !== "function") throw new Error("Browser archive storage is unavailable.");
  const keys = new Set(readCodingPlanArchives(projectId, storage));
  const key = codingPlanArchiveKey(plan);
  if (archived) keys.add(key); else keys.delete(key);
  const next = [...keys];
  storage.setItem(codingPlanArchiveStorageKey(projectId), JSON.stringify(next));
  return next;
}

// Lists every actionable plan while hiding only exact revisions archived in this browser.
export function codingArchitecturePlanList(plans, archives, showArchived = false) {
  const keys = new Set(archives);
  return plans.filter((plan) => showArchived || !keys.has(codingPlanArchiveKey(plan)));
}
