// Reads membership and project configurations independently from workspace admission, while
// updating running project status and progress percentages in real time from SSE events.
import { forgeV1 } from "./node-client-url.js";
import { requestJson } from "./node-client-request.js";
import { lifecycleRequest } from "./project-lifecycle-client.js";
import { syncProjectsToSelection } from "./project-selection.js";

const STAGE_ORDER = ["preflight", "identity", "membership", "comment_normalization", "scan/index", "resolve", "embedding", "startup/readiness"];
const STAGE_WEIGHTS = { preflight: 10, identity: 20, membership: 30, comment_normalization: 45, "scan/index": 65, resolve: 80, embedding: 90, "startup/readiness": 95 };

let snapshot = { projects: [], loaded: false, stale: false, error: null };
let generation = 0;
const listeners = new Set();

// Supply a stable membership snapshot without treating catalog entries as workspace admission.
export function getProjectDirectory() { return snapshot; }

// Notify directory views of successful refreshes, mutations, and live SSE state transitions.
export function subscribeProjectDirectory(listener) { listeners.add(listener); return () => listeners.delete(listener); }

// Publish directory state after validation, preserving cards on connection or response-format failures.
function publish(update) {
  snapshot = { ...snapshot, ...update };
  for (const listener of listeners) listener();
}

// Business purpose: normalizes backend catalog entries from `/forge/v1/projects` or `/lifecycle/directory` into a consistent UI project record with computed progress percentage and readiness.
// Technical description: resolves `project_id` from `project_id` or `projectId`, preserves extended configuration fields, diagnostics, and operation metadata, and derives a deterministic percentage when running.
export function normalizeDirectoryProject(raw = {}) {
  const projectId = String(raw.project_id ?? raw.projectId ?? "").trim();
  const readiness = ["ready", "running", "unavailable"].includes(raw.readiness)
    ? raw.readiness
    : raw.status === "ready" || raw.progress?.status === "succeeded" ? "ready"
      : raw.status === "running" || raw.progress?.status === "running" ? "running" : "unavailable";
  const percent = computeProjectProgressPercent({ ...raw, readiness });
  return {
    ...raw,
    project_id: projectId,
    projectId,
    readiness,
    percent
  };
}

// Business purpose: computes an accurate 0–100 progress percentage for a project card from backend SSE or catalog progress payloads so operators can track running initialization and indexing stages.
// Technical description: checks explicit numeric `percent`/`percentage` fields on the project or progress object first, then derives progress from completed stages and current stage weights, returning 100 when `ready`.
export function computeProjectProgressPercent(project = {}) {
  const explicit = project.percent ?? project.percentage ?? project.progress?.percent ?? project.progress?.percentage ?? project.progress?.progress?.percent;
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.max(0, Math.min(100, Math.round(explicit)));
  }
  if (project.readiness === "ready" || project.progress?.status === "succeeded") return 100;
  const progress = project.progress;
  if (!progress || typeof progress !== "object") return project.readiness === "running" ? 5 : null;
  const stageWeight = typeof progress.stage === "string" && STAGE_WEIGHTS[progress.stage] ? STAGE_WEIGHTS[progress.stage] : 0;
  if (progress.stages && typeof progress.stages === "object") {
    const completed = STAGE_ORDER.filter((stage) => progress.stages[stage] === "completed").length;
    const running = STAGE_ORDER.some((stage) => progress.stages[stage] === "running") ? 0.5 : 0;
    const derived = Math.round(((completed + running) / STAGE_ORDER.length) * 100);
    const best = Math.max(derived, stageWeight);
    if (best > 0) return Math.min(99, best);
  }
  if (stageWeight > 0) return stageWeight;
  return project.readiness === "running" ? 10 : null;
}

// Fence concurrent reads so an older directory response cannot undo the latest authoritative snapshot.
export async function refreshProjectDirectory() {
  const current = ++generation;
  try {
    let result;
    try {
      result = await requestJson(forgeV1("/projects"), { cache: "no-store" });
    } catch (primaryError) {
      if (primaryError?.status === 404 || primaryError?.status === 405) {
        result = await lifecycleRequest("directory");
      } else {
        throw primaryError;
      }
    }
    const rawProjects = Array.isArray(result) ? result : result?.projects;
    if (!Array.isArray(rawProjects) || rawProjects.some((project) =>
      typeof (project?.project_id ?? project?.projectId) !== "string" || typeof project?.root !== "string")) {
      throw new Error("Invalid backend directory response.");
    }
    const projects = rawProjects.map(normalizeDirectoryProject);
    if (current === generation) {
      publish({ projects, loaded: true, stale: false, error: null });
      syncProjectsToSelection(projects);
    }
    return projects;
  } catch (error) {
    if (current === generation) publish({ stale: true, error: error.message });
    throw error;
  }
}

// Business purpose: inserts or updates a project card in the directory state immediately after add or edit without requiring a full directory reload or polling loop.
// Technical description: normalizes the incoming project record, merges it with any existing entry for the same `project_id`, publishes the updated directory list, and synchronizes ready projects with the selection store.
export function upsertDirectoryProject(project) {
  const normalized = normalizeDirectoryProject(project);
  if (!normalized.project_id) return null;
  const exists = snapshot.projects.some((item) => item.project_id === normalized.project_id);
  const projects = exists
    ? snapshot.projects.map((item) => item.project_id === normalized.project_id ? normalizeDirectoryProject({ ...item, ...project, project_id: normalized.project_id }) : item)
    : [...snapshot.projects, normalized];
  publish({ projects, loaded: true, stale: false, error: null });
  syncProjectsToSelection(projects);
  return projects.find((item) => item.project_id === normalized.project_id) ?? normalized;
}

// Business purpose: removes a deleted project card from the directory snapshot immediately after backend confirmation while keeping remaining projects intact.
// Technical description: filters out the matching `project_id` from `snapshot.projects`, publishes the updated collection, and updates the project selection store.
export function removeDirectoryProject(projectId) {
  const projects = snapshot.projects.filter((item) => item.project_id !== projectId);
  publish({ projects, loaded: true });
  syncProjectsToSelection(projects);
}

// Business purpose: applies real-time SSE events from `/forge/v1/stream?project=<projectId>` directly onto the matching project card so status, progress percentage, readiness, and diagnostics update without polling.
// Technical description: inspects `stream.snapshot`, `agent.activity`, `watcher.file_indexed`, and project progress/error events to update `readiness`, `percent`, `progress`, and `diagnostic` for the target project.
export function applyProjectDirectoryStreamEvent(projectId, event) {
  if (!projectId || !event || typeof event !== "object") return;
  if (event.project_id && event.project_id !== projectId) return;
  const index = snapshot.projects.findIndex((item) => item.project_id === projectId);
  if (index < 0) return;
  const current = snapshot.projects[index];
  const payload = event.payload ?? {};
  const runtime = payload.runtime ?? payload;
  let readiness = current.readiness;
  let progress = current.progress ? { ...current.progress } : {};
  let diagnostic = current.diagnostic;
  let explicitPercent = payload.percent ?? payload.percentage ?? runtime.percent ?? runtime.percentage ?? runtime.progress?.percent ?? runtime.progress?.percentage;

  if (runtime.progress && typeof runtime.progress === "object") {
    progress = { ...progress, ...runtime.progress };
  }
  if (typeof runtime.stage === "string") progress.stage = runtime.stage;
  if (typeof runtime.status === "string" && ["running", "succeeded", "failed"].includes(runtime.status)) {
    progress.status = runtime.status;
  }
  if (typeof runtime.readiness === "string" && ["ready", "running", "unavailable"].includes(runtime.readiness)) {
    readiness = runtime.readiness;
  }
  if (event.event_type === "agent.activity") {
    const summary = String(payload.summary ?? "");
    const stageMatch = /Stage\s+([^\s:]+):\s*(running|succeeded|failed|completed)/i.exec(summary);
    if (stageMatch) {
      const [, stageName, stageStatus] = stageMatch;
      progress.stage = stageName;
      progress.stages = { ...(progress.stages ?? {}), [stageName]: stageStatus === "succeeded" ? "completed" : stageStatus };
      if (stageStatus === "failed") {
        progress.status = "failed";
        readiness = "unavailable";
      } else if ((stageName === "startup/readiness" || stageName === "ready") && (stageStatus === "succeeded" || stageStatus === "completed")) {
        progress.status = "succeeded";
        readiness = "ready";
        explicitPercent = 100;
      }
    }
    if (payload.activity_type === "failed" || payload.status === "failed") {
      readiness = "unavailable";
      progress.status = "failed";
      const errObj = payload.error ?? payload.diagnostic ?? {};
      diagnostic = {
        code: errObj.code ?? payload.code ?? "index_failed",
        message: errObj.message ?? payload.message ?? (summary || "Project initialization failed.")
      };
    } else if (payload.activity_type === "completed" && (progress.stage === "startup/readiness" || payload.readiness === "ready" || explicitPercent === 100)) {
      readiness = "ready";
      progress.status = "succeeded";
      explicitPercent = 100;
      diagnostic = null;
    }
  }
  if (event.event_type === "watcher.file_indexed" || event.event_type === "indexer.indexed" || event.event_type === "watcher.indexed") {
    const counters = { ...(progress.counters ?? {}) };
    counters.indexed = (counters.indexed ?? 0) + 1;
    progress.counters = counters;
    if (!progress.stage || progress.stage === "preflight" || progress.stage === "comment_normalization") {
      progress.stage = "scan/index";
    }
  }
  if (event.event_type === "stream.error" || event.event_type === "project.failed" || payload.status === "failed" || runtime.status === "failed") {
    readiness = "unavailable";
    progress.status = "failed";
    const errObj = payload.error ?? payload.diagnostic ?? runtime.diagnostic ?? runtime.error ?? payload;
    diagnostic = {
      code: errObj.code ?? payload.code ?? "project_failed",
      message: errObj.message ?? payload.message ?? "Project initialization or indexing failed.",
      ...(errObj.stage ? { stage: errObj.stage } : {}),
      ...(errObj.guidance ? { guidance: errObj.guidance } : {})
    };
  }
  if (event.event_type === "project.ready" || payload.readiness === "ready" || runtime.readiness === "ready" || progress.status === "succeeded" || explicitPercent === 100) {
    if (readiness !== "unavailable" || payload.readiness === "ready" || runtime.readiness === "ready" || event.event_type === "project.ready") {
      readiness = "ready";
      progress.status = "succeeded";
      explicitPercent = 100;
      diagnostic = null;
    }
  }
  const { percent: _previousPercent, percentage: _previousPercentage, ...currentBase } = current;
  const updated = normalizeDirectoryProject({
    ...currentBase,
    readiness,
    progress,
    diagnostic,
    ...(explicitPercent !== undefined ? { percent: explicitPercent } : {})
  });
  const projects = [...snapshot.projects];
  projects[index] = updated;
  publish({ projects });
  syncProjectsToSelection(projects);
}
