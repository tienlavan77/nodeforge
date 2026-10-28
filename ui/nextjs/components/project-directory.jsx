// Let owners choose or add an admitted project before opening an Architecture workspace.
"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ProjectCard } from "./project-card.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ProjectAddModal, ProjectDeleteModal, ProjectEditModal } from "./project-modals.jsx";
import { getProjectSelection, subscribeProjectSelection } from "../lib/project-selection.js";
import {
  applyProjectDirectoryStreamEvent,
  getProjectDirectory,
  refreshProjectDirectory,
  removeDirectoryProject,
  subscribeProjectDirectory,
  upsertDirectoryProject
} from "../lib/project-directory-client.js";
import {
  deleteManagedProject,
  formatProjectBackendError,
  getLifecycleSnapshot,
  intakeProject,
  submitProjectOperation,
  subscribeLifecycle,
  updateProjectConfiguration
} from "../lib/project-lifecycle-client.js";
import { createProjectStreamClient } from "../lib/project-stream-client.js";
import { forgeV1 } from "../lib/node-client-url.js";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ProjectOperationStatus } from "./project-operation-status.jsx";

const initialSelection = { projects: [], loaded: false, error: null };
const directoryAttempts = new Map();

// Render project cards and recoverable directory errors without mounting project-bound chat clients.
export function ProjectDirectory({ onNavigate }) {
  let router = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- useRouter is safe in Next App Router and guarded for standalone browser test bundles.
    router = useRouter();
  } catch (error) {
    router = null;
  }
  const selection = useSyncExternalStore(subscribeProjectSelection, getProjectSelection, () => initialSelection);
  const directory = useSyncExternalStore(subscribeProjectDirectory, getProjectDirectory, () => initialSelection);
  const lifecycle = useSyncExternalStore(subscribeLifecycle, getLifecycleSnapshot, getLifecycleSnapshot);
  const connectProjectStream = useMemo(() => createProjectStreamClient(forgeV1), []);
  const streamsRef = useRef(new Map());
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [editingProject, setEditingProject] = useState(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [deletingProject, setDeletingProject] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // Refresh the actual runtime directory once on mount or explicit retry while keeping a failed request visible and retryable.
  async function load() {
    setLoading(true); setError("");
    try {
      await refreshProjectDirectory();
      setLoading(false);
      return true;
    } catch (failure) {
      setError(formatProjectBackendError(failure, failure.message));
      setLoading(false);
      return false;
    }
  }

  // Call GET /forge/v1/projects exactly once when opening the page without any setTimeout polling loop.
  useEffect(() => {
    void load();
  }, []);

  // Connect to /forge/v1/stream?project=<projectId> for every running project so progress and readiness update live via SSE.
  const runningIdsKey = directory.projects
    .filter((project) => project.readiness === "running")
    .map((project) => project.project_id)
    .sort()
    .join("\0");

  useEffect(() => {
    const runningIds = new Set(runningIdsKey ? runningIdsKey.split("\0") : []);
    const activeStreams = streamsRef.current;
    for (const [id, stream] of activeStreams.entries()) {
      if (!runningIds.has(id)) {
        stream.close();
        activeStreams.delete(id);
      }
    }
    for (const projectId of runningIds) {
      if (activeStreams.has(projectId)) continue;
      try {
        const stream = connectProjectStream({
          projectId,
          onEvent: (event) => applyProjectDirectoryStreamEvent(projectId, event),
          onError: (streamError) => {
            if (streamError?.code && streamError.code !== "STREAM_RECONNECTING") {
              console.warn("Project SSE stream error", streamError);
            }
          }
        });
        activeStreams.set(projectId, stream);
      } catch (streamInitError) {
        console.warn("Unable to open project SSE stream", streamInitError);
      }
    }
  }, [runningIdsKey, connectProjectStream]);

  useEffect(() => () => {
    for (const stream of streamsRef.current.values()) stream.close();
    streamsRef.current.clear();
  }, []);

  // Business purpose: submits a validated new/imported project to `POST /forge/v1/projects`, immediately closes the Add modal on acceptance, and renders the new running card with live SSE progress.
  // Technical description: invokes `intakeProject(payload)`, upserts the returned project into the directory store with `running` or `ready` status, closes the modal, and surfaces any backend error inside the modal without hiding failure.
  async function handleAddSubmit(payload) {
    setSaving(true); setFormError("");
    try {
      const created = await intakeProject(payload);
      const projectRecord = {
        ...payload,
        ...created,
        project_id: created?.project_id ?? created?.projectId,
        readiness: created?.readiness ?? (created?.progress?.status === "succeeded" ? "ready" : "running")
      };
      upsertDirectoryProject(projectRecord);
      setAdding(false);
      setNotice("Project added.");
    } catch (failure) {
      setFormError(formatProjectBackendError(failure, "Could not add project."));
    } finally {
      setSaving(false);
    }
  }

  // Business purpose: saves updated project configuration fields via `PUT /forge/v1/projects/<projectId>` and updates the corresponding card or keeps the Edit modal open with the exact backend error.
  // Technical description: calls `updateProjectConfiguration`, merges the returned configuration into the directory store, and closes the Edit modal on success.
  async function handleEditSave(projectId, updates) {
    setEditSaving(true); setEditError("");
    try {
      const updated = await updateProjectConfiguration(projectId, updates);
      upsertDirectoryProject({ ...editingProject, ...updates, ...updated, project_id: projectId });
      setEditingProject(null);
    } catch (failure) {
      setEditError(formatProjectBackendError(failure, "Could not update project configuration."));
    } finally {
      setEditSaving(false);
    }
  }

  // Business purpose: confirms removal of a project from NodeForge's managed list via `DELETE /forge/v1/projects/<projectId>` while preserving files on disk and surfacing any backend error.
  // Technical description: invokes `deleteManagedProject(project.project_id)`, removes only the confirmed card on success, and displays backend error details if deletion fails.
  async function handleDeleteConfirm(project) {
    setDeleting(true); setDeleteError("");
    try {
      await deleteManagedProject(project.project_id);
      removeDirectoryProject(project.project_id);
      setDeletingProject(null);
    } catch (failure) {
      setDeleteError(formatProjectBackendError(failure, "Could not remove project."));
    } finally {
      setDeleting(false);
    }
  }

  // Business purpose: navigates to `/<projectId>` when a `ready` project card is activated.
  // Technical description: delegates to `onNavigate`, Next router, or browser history pushState.
  function handleCardNavigate(targetPath, projectId) {
    if (onNavigate) {
      onNavigate(targetPath, projectId);
      return;
    }
    if (router?.push) {
      router.push(targetPath);
      return;
    }
    if (typeof window !== "undefined" && window.history?.pushState) {
      window.history.pushState({}, "", targetPath);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }

  const loadingStatus = loading && !directory.loaded;
  const operations = Object.values(lifecycle.operations);
  // Resolve tracked operations by backend identity or submitted root without inventing directory membership.
  function operationFor(project) {
    const operation = operations.filter((entry) => entry.project_id === project.project_id || entry.root === project.root).at(-1);
    if (!operation) return undefined;
    const previous = directoryAttempts.get(operation.request_key);
    if (!previous || operation.attempt > previous.attempt) {
      directoryAttempts.set(operation.request_key, { attempt: operation.attempt, directoryAttempt: project.operation?.attempt_id,
        awaitingAttempt: operation.status === "running" && project.operation?.status !== "running" });
    }
    const associated = directoryAttempts.get(operation.request_key);
    if (associated.directoryAttempt !== project.operation?.attempt_id) {
      if (!associated.awaitingAttempt) return undefined;
      associated.directoryAttempt = project.operation?.attempt_id;
      associated.awaitingAttempt = false;
    }
    if (["failed", "succeeded"].includes(operation.status) && project.operation?.status !== operation.status) return undefined;
    return operation;
  }
  // Recover a membership-only startup failure through the backend's documented explicit Add path.
  async function retryAdd(path) {
    try { await submitProjectOperation("add", path); await load(); }
    catch (failure) { setError(formatProjectBackendError(failure, failure.message)); }
  }
  const statusMessage = error || (loadingStatus ? "Loading projects…" : "");

  return <div className="app-shell app-shell-control-room projects-directory-shell">
    <p role={error ? "alert" : "status"} aria-live="polite" className="project-workspace-stale" hidden={!statusMessage}>
      {error ? <span role="alert">Connection to the Node API was lost. Showing the last known project list; some information may be out of date. <span className="project-directory-error-detail">{error}</span> <button className="history-button" type="button" onClick={load} disabled={loading}>{loading ? "Connecting…" : "Reload directory"}</button></span> : statusMessage}
    </p>
    <p role="status" aria-live="polite" className="project-workspace-stale" hidden={!notice}>{notice}</p>
    <main className="projects-directory" aria-label="Projects directory">
      <section className="projects-stage" aria-labelledby="projects-brand-title">
        <div className="projects-hero">
          <div className="projects-brand-badge"><span className="projects-brand-mark" aria-hidden="true">N</span><span className="projects-brand-kicker"><i aria-hidden="true" />AI ENGINEERING CONTROL ROOM</span></div>
          <h1 id="projects-brand-title">NodeForge</h1>
          <p className="projects-hero-lead">Không gian phát triển phần mềm cùng đội ngũ AI — chọn một dự án để bắt đầu điều phối kiến trúc, sprint và mã nguồn.</p>
        </div>
        <div className="projects-workspace-panel" aria-label="Project workspaces">
          <div className="projects-section-bar">
            <span className="projects-section-label">ACTIVE WORKSPACES</span>
            <span className="projects-section-count">{`${directory.projects.length} project${directory.projects.length === 1 ? "" : "s"}`}</span>
          </div>
          {!loading && !error && !directory.projects.length && <p className="agents-directory-state">No projects yet. Add a project to get started.</p>}
          <div className="agents-card-grid projects-card-grid">
            {directory.projects.map((project) => {
              const operation = operationFor(project);
              const isAdmitted = project.readiness === "ready" || selection.projects.some((entry) => entry.project_id === project.project_id);
              return <ProjectCard key={project.project_id} project={project} admitted={isAdmitted}
                operation={operation} onRetry={retryAdd}
                onEdit={(target) => { setEditError(""); setEditingProject(target); }}
                onDelete={(target) => { setDeleteError(""); setDeletingProject(target); }}
                onNavigate={handleCardNavigate}>
                {operation && <ProjectOperationStatus operation={operation} connectionError={lifecycle.errors[operation.request_key]} retryable={project.retryable} onChange={load} />}
              </ProjectCard>;
            })}
            <button className="agent-directory-card agent-add-card project-add-card" type="button" aria-label="Add project" onClick={() => { setFormError(""); setAdding(true); }}><span aria-hidden="true">＋</span><strong>Add project</strong><small>Open another workspace</small></button>
          </div>
        </div>
      </section>
      <section className="projects-introduction" aria-labelledby="projects-introduction-title" lang="vi">
        <div className="projects-introduction-header">
          <span className="projects-intro-eyebrow">QUY TRÌNH KHÉP KÍN</span>
          <h2 id="projects-introduction-title">Từ ý tưởng đến sản phẩm, trong một không gian.</h2>
          <p>NodeForge kết nối trao đổi, lập kế hoạch và triển khai mã nguồn theo từng dự án. Bạn định hướng và phê duyệt; các agent phối hợp thực hiện với tiến độ và kết quả kiểm tra rõ ràng.</p>
        </div>
        <div className="projects-features">
          <article className="projects-feature-card"><span className="projects-feature-step" aria-hidden="true">01</span><h3>Làm rõ ý tưởng</h3><p>Trao đổi với Architecture Manager để xác định phạm vi và xây dựng kế hoạch có thể xem xét trước khi triển khai.</p></article>
          <article className="projects-feature-card"><span className="projects-feature-step" aria-hidden="true">02</span><h3>Phối hợp thực hiện</h3><p>Tổ chức công việc theo sprint và ticket, với các agent đảm nhiệm lập kế hoạch, viết mã và review.</p></article>
          <article className="projects-feature-card"><span className="projects-feature-step" aria-hidden="true">03</span><h3>Theo dõi &amp; kiểm chứng</h3><p>Theo dõi hoạt động của agent, thay đổi Git và kết quả kiểm tra trong không gian riêng của mỗi project.</p></article>
        </div>
      </section>
    </main>
    <section className="projects-tracked-operations" aria-label="Tracked operations">
      {Object.values(lifecycle.pending).filter((intent) => !directory.projects.some((project) => project.root === intent.root)).map((intent) =>
        <ProjectOperationStatus key={intent.request_key} intent={intent} operation={lifecycle.operations[intent.request_key]} connectionError={lifecycle.errors[intent.request_key]} onChange={load} />)}
    </section>
    <ProjectAddModal open={adding} saving={saving} error={formError} onClose={() => { if (!saving) setAdding(false); }} onSubmit={handleAddSubmit} />
    <ProjectEditModal project={editingProject} saving={editSaving} error={editError} onClose={() => { if (!editSaving) setEditingProject(null); }} onSave={handleEditSave} />
    <ProjectDeleteModal project={deletingProject} deleting={deleting} error={deleteError} onClose={() => { if (!deleting) setDeletingProject(null); }} onConfirm={handleDeleteConfirm} />
  </div>;
}
