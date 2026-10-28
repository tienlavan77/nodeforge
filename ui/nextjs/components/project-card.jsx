// Present an admitted project as a keyboard-accessible card using the agent directory's visual structure.
"use client";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import Link from "next/link";
import { projectArchitecturePath } from "../lib/project-navigation.js";
import { selectProject } from "../lib/project-selection.js";
import { computeProjectProgressPercent } from "../lib/project-directory-client.js";
import { formatProjectBackendError } from "../lib/project-lifecycle-client.js";

// Open the project's Architecture workspace through its persisted identity when ready, while keeping Edit/Delete and live progress controls distinct.
export function ProjectCard({ project, admitted = true, operation, children, onRetry, onEdit, onDelete, onNavigate }) {
  const name = project.name || project.root?.split("/").filter(Boolean).at(-1) || project.project_id;
  const ready = Boolean(admitted && project.readiness === "ready" && (!operation || operation.status === "succeeded"));
  const running = project.readiness === "running" || operation?.status === "running";
  const percent = computeProjectProgressPercent(project);
  const stage = project.progress?.stage || operation?.progress?.stage || operation?.stage || "initializing";
  const targetPath = projectArchitecturePath(project.project_id);
  const diagnosticText = project.diagnostic ? formatProjectBackendError(project.diagnostic, project.diagnostic.message) : "";

  // Business purpose: navigates to the project's workspace `/<projectId>` when clicking anywhere on a `ready` card outside its Edit, Delete, or retry buttons.
  // Technical description: checks `ready` state and verifies the click target is not inside an interactive button before recording project selection and routing to `targetPath`.
  function handleCardClick(event) {
    if (!ready) return;
    if (event.target?.closest?.("button, [data-card-action]")) return;
    try { selectProject(project.project_id); } catch (error) { console.warn("Could not pre-select project", error); }
    if (onNavigate) {
      event.preventDefault();
      onNavigate(targetPath, project.project_id);
      return;
    }
    if (!event.target?.closest?.("a")) {
      if (typeof window !== "undefined" && window.history?.pushState) {
        window.history.pushState({}, "", targetPath);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
    }
  }

  // Business purpose: supports keyboard activation (Enter/Space) on the card container when `ready` without interfering with nested action buttons.
  // Technical description: triggers `handleCardClick` when `Enter` or ` ` is pressed directly on the card element.
  function handleCardKeyDown(event) {
    if (!ready || event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleCardClick(event);
    }
  }

  return <article
    className={`agent-directory-card project-card${ready ? " is-ready" : running ? " is-running" : " is-unavailable"}`}
    aria-label={name}
    data-project-id={project.project_id}
    data-readiness={project.readiness}
    tabIndex={ready ? 0 : undefined}
    onClick={handleCardClick}
    onKeyDown={handleCardKeyDown}
  >
    <div className="agent-card-header">
      <strong>{name}</strong>
      <div className="project-card-actions" data-card-action="true" onClick={(event) => event.stopPropagation()}>
        {onEdit && <button type="button" className="card-action-button project-edit-button" aria-label={`Edit ${name}`} onClick={(event) => { event.stopPropagation(); onEdit(project); }}>Edit</button>}
        {onDelete && <button type="button" className="card-action-button danger project-delete-button" aria-label={`Delete ${name}`} onClick={(event) => { event.stopPropagation(); onDelete(project); }}>Delete</button>}
        <span className="project-card-type">{ready ? "READY" : running ? "RUNNING" : "PROJECT"}</span>
      </div>
    </div>
    <div className="project-card-body">
      <span className="project-card-icon" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M5 12h15l5 6h18v22H5V12Z" /><path d="M5 18h38M16 29h16M24 25v8" /></svg></span>
      <span className="project-card-root" title={project.root}>{project.root}</span>
      {project.description && <span className="project-card-description">{project.description}</span>}
    </div>
    {running && <div className="project-card-progress" role="status" aria-live="polite" data-project-progress={percent ?? 0}>
      <div className="project-card-progress-meta">
        <span className="project-card-stage">{stage}</span>
        <span className="project-card-percent">{`${percent ?? 0}%`}</span>
      </div>
      <progress className="project-operation-progress" aria-label={`${name} progress`} max={100} value={percent ?? 0} />
    </div>}
    <div className="agent-card-footer">
      <span className="project-card-id">{project.project_id}</span>
      {ready ? <Link className="project-card-open" href={targetPath} onClick={(event) => { try { selectProject(project.project_id); } catch (error) { console.warn("Could not select project", error); } if (onNavigate) { event.preventDefault(); event.stopPropagation(); onNavigate(targetPath, project.project_id); } }} aria-label={`Open ${name}`}>Architecture <span aria-hidden="true">↗</span></Link> : <span className="project-card-unavailable">{running ? `Running (${percent ?? 0}%)` : "Workspace unavailable"}</span>}
    </div>
    {!operation && (diagnosticText || (project.retryable && onRetry)) && <div className="project-card-status" aria-live="polite">
      {diagnosticText && <p className="project-card-error" role="alert" data-error="project">{diagnosticText}</p>}
      {project.retryable && onRetry && <button className="history-button project-card-retry" type="button" onClick={(event) => { event.stopPropagation(); onRetry(project.root); }}>Retry Add</button>}
    </div>}
    {children}
  </article>;
}
