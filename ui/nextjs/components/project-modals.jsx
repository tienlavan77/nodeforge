// Provides the Add, Edit, and Delete confirmation dialogs for project management in the ProjectDirectory.
// Business purpose: enables operators to preflight and onboard new projects with automatic metadata suggestions, edit every approved O1/O3 project configuration field, and confirm safe catalog removal that preserves files on disk while keeping backend errors visible.
// Technical description: renders accessible Dialog modals for preflight-backed project intake (`ProjectAddModal`), full schema-compliant project configuration editing (`ProjectEditModal`), and non-destructive removal confirmation (`ProjectDeleteModal`).
"use client";
import { useEffect, useRef, useState } from "react";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { Dialog } from "./Dialog.jsx";
import { buildProjectConfigurationUpdate, createProjectEditForm, formatProjectBackendError, preflightProjectPath } from "../lib/project-lifecycle-client.js";

export { createProjectEditForm, buildProjectConfigurationUpdate };

// Business purpose: guides the operator through adding a project with live `/forge/v1/projects/preflight` verification, automatic suggestion filling, and required `(name, description, author, root)` validation.
// Technical description: checks the root path via `preflightProjectPath`, renders distinct `existing`, `new`, and `invalid` preflight states, auto-fills empty fields from `suggestions`, and submits the intake payload without a manual Create/Add selector.
export function ProjectAddModal({ open, saving, error, onClose, onSubmit }) {
  const [root, setRoot] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [author, setAuthor] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [preflight, setPreflight] = useState(null);
  const [checking, setChecking] = useState(false);
  const [localError, setLocalError] = useState("");
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!open) {
      setRoot(""); setName(""); setDescription(""); setAuthor(""); setGitUrl("");
      setPreflight(null); setChecking(false); setLocalError("");
    }
  }, [open]);

  // Business purpose: runs path preflight against `/forge/v1/projects/preflight` and populates available suggestions so the user sees path validity and metadata before submitting.
  // Technical description: sends the trimmed root path, updates `preflight` state (`existing`, `new`, or `invalid`), and fills `name`, `description`, `author`, and `git_url` when suggestions are returned.
  async function runPreflight(candidateRoot) {
    const trimmed = String(candidateRoot ?? "").trim();
    if (!trimmed) { setPreflight(null); return null; }
    const seq = ++requestSeq.current;
    setChecking(true);
    try {
      const result = await preflightProjectPath(trimmed);
      if (seq !== requestSeq.current) return result;
      setPreflight(result);
      if (result?.suggestions) {
        const s = result.suggestions;
        if (typeof s.name === "string" && s.name) setName((prev) => prev || s.name);
        if (typeof s.description === "string" && s.description) setDescription((prev) => prev || s.description);
        if (typeof s.author === "string" && s.author) setAuthor((prev) => prev || s.author);
        if (typeof s.git_url === "string" && s.git_url) setGitUrl((prev) => prev || s.git_url);
      }
      return result;
    } catch (err) {
      const formatted = formatProjectBackendError(err, "Preflight check failed.");
      const failState = { status: "invalid", code: err?.rawCode ?? err?.code ?? "preflight_failed", message: formatted };
      if (seq === requestSeq.current) setPreflight(failState);
      return failState;
    } finally {
      if (seq === requestSeq.current) setChecking(false);
    }
  }

  // Business purpose: validates required project fields `(name, description, author, root)` and submits the intake request.
  // Technical description: ensures all four mandatory fields are non-empty, triggers preflight if needed, and invokes `onSubmit` with the normalized configuration payload.
  async function handleSubmit(event) {
    event.preventDefault();
    setLocalError("");
    const trimmedRoot = root.trim();
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    const trimmedAuthor = author.trim();
    if (!trimmedRoot || !trimmedRoot.startsWith("/")) { setLocalError("Enter an absolute server path."); return; }
    if (!trimmedName || !trimmedDescription || !trimmedAuthor) { setLocalError("Name, description, author and root are required."); return; }
    await onSubmit({ root: trimmedRoot, name: trimmedName, description: trimmedDescription, author: trimmedAuthor, ...(gitUrl.trim() ? { git_url: gitUrl.trim() } : {}) });
  }

  const displayError = error || localError || (preflight?.status === "invalid" ? formatProjectBackendError(preflight, preflight.message) : "");

  return <Dialog open={open} onClose={() => { if (!saving) onClose(); }} labelledBy="project-add-title" panelStyle={{ width: "min(560px, calc(100vw - 32px))", borderRadius: 0, background: "var(--app-panel)" }}>
    <div className="agent-modal project-add-modal">
      <header><div><p className="eyebrow">WORKSPACE</p><h2 id="project-add-title">Add project</h2></div><button className="agent-modal-close" type="button" aria-label="Close" onClick={onClose} disabled={saving}>×</button></header>
      <form onSubmit={handleSubmit}>
        <label>Absolute server path
          <div className="project-preflight-row">
            <input name="root" required aria-invalid={Boolean(displayError)} aria-describedby="project-path-help project-field-error" placeholder="/home/data/sites/my-project" value={root} onChange={(event) => { const next = event.target.value; setRoot(next); setLocalError(""); if (next.trim().startsWith("/")) void runPreflight(next); else setPreflight(null); }} onBlur={(event) => { if (event.target.value.trim()) void runPreflight(event.target.value); }} />
            <button className="history-button" type="button" onClick={() => void runPreflight(root)} disabled={checking || saving}>{checking ? "Checking…" : "Check path"}</button>
          </div>
        </label>
        <p id="project-path-help" className="project-path-help">This path is on the Node server.</p>
        {preflight && <div className={`project-preflight-status is-${preflight.status}`} role={preflight.status === "invalid" ? "alert" : "status"} data-preflight-status={preflight.status}>
          {preflight.status === "existing" && <span>Existing source directory ({preflight.root || root.trim()}). Suggestions loaded where available.</span>}
          {preflight.status === "new" && <span>New or empty target directory ({preflight.root || root.trim()}). A new project workspace will be initialized.</span>}
          {preflight.status === "invalid" && <span>{formatProjectBackendError(preflight, "Invalid project root path.")}</span>}
        </div>}
        <label>Project name<input name="name" required placeholder="My Project" value={name} onChange={(event) => { setName(event.target.value); setLocalError(""); }} /></label>
        <label>Description<input name="description" required placeholder="Project description" value={description} onChange={(event) => { setDescription(event.target.value); setLocalError(""); }} /></label>
        <label>Author<input name="author" required placeholder="Project author" value={author} onChange={(event) => { setAuthor(event.target.value); setLocalError(""); }} /></label>
        <label>Git URL<input name="git_url" placeholder="https://example.org/repo.git" value={gitUrl} onChange={(event) => setGitUrl(event.target.value)} /></label>
        {displayError && <p id="project-field-error" className="agent-form-error" role="alert" data-error="field">{displayError}</p>}
        <div className="agent-modal-actions"><button className="history-button" type="button" onClick={onClose} disabled={saving}>Cancel</button><button className="history-button agent-submit-button" type="submit" disabled={saving}>{saving ? "Submitting…" : "Add project"}</button></div>
      </form>
    </div>
  </Dialog>;
}

// Business purpose: allows operators to edit every approved project configuration field in Section 5 (`name`, `description`, `author`, `git_url`, `default_branch`, `default_workflow_id`, `language`, `package_manager`, `comment_language`, `commands`, `default_agents`, `watch`, `tags`, `homepage_url`, `docs_url`, `metadata`) and persist changes via `PUT /forge/v1/projects/<projectId>`.
// Technical description: initializes form controls from the selected project, updates fields locally, validates and builds the nested update object on submit, and displays any backend error without closing the modal on failure.
export function ProjectEditModal({ project, saving, error, onClose, onSave }) {
  const [form, setForm] = useState(() => createProjectEditForm(project));
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    if (project) { setForm(createProjectEditForm(project)); setLocalError(""); }
  }, [project]);

  if (!project) return null;

  // Business purpose: updates a single configuration field in the Edit modal state as the operator types.
  // Technical description: reads `name` and `value` from the input change event and merges them into `form`.
  function handleChange(event) {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setLocalError("");
  }

  // Business purpose: validates and submits the edited project configuration to the backend.
  // Technical description: transforms the flat form state into the nested Section 5 configuration schema and invokes `onSave(project.project_id, updates)`.
  async function handleSubmit(event) {
    event.preventDefault();
    setLocalError("");
    try {
      const updates = buildProjectConfigurationUpdate(form);
      await onSave(project.project_id, updates);
    } catch (err) {
      setLocalError(formatProjectBackendError(err, "Could not update project configuration."));
    }
  }

  const displayError = error || localError;

  return <Dialog open={Boolean(project)} onClose={() => { if (!saving) onClose(); }} labelledBy="project-edit-title" panelStyle={{ width: "min(680px, calc(100vw - 32px))", maxHeight: "min(88vh, calc(100vh - 32px))", overflowY: "auto", borderRadius: 0, background: "var(--app-panel)" }}>
    <div className="agent-modal project-edit-modal">
      <header><div><p className="eyebrow">PROJECT CONFIGURATION</p><h2 id="project-edit-title">Edit project</h2></div><button className="agent-modal-close" type="button" aria-label="Close" onClick={onClose} disabled={saving}>×</button></header>
      <form onSubmit={handleSubmit}>
        <div className="project-edit-grid">
          <label>Project name<input name="name" required value={form.name} onChange={handleChange} /></label>
          <label>Author<input name="author" value={form.author} onChange={handleChange} /></label>
          <label>Description<input name="description" value={form.description} onChange={handleChange} /></label>
          <label>Git URL<input name="git_url" value={form.git_url} onChange={handleChange} /></label>
          <label>Default branch<input name="default_branch" value={form.default_branch} onChange={handleChange} /></label>
          <label>Default workflow ID<input name="default_workflow_id" value={form.default_workflow_id} onChange={handleChange} /></label>
          <label>Language<input name="language" value={form.language} onChange={handleChange} /></label>
          <label>Package manager<input name="package_manager" value={form.package_manager} onChange={handleChange} /></label>
          <label>Comment language<input name="comment_language" value={form.comment_language} onChange={handleChange} /></label>
          <label>Homepage URL<input name="homepage_url" value={form.homepage_url} onChange={handleChange} /></label>
          <label>Docs URL<input name="docs_url" value={form.docs_url} onChange={handleChange} /></label>
          <label>Tags<input name="tags" placeholder="tag1, tag2" value={form.tags} onChange={handleChange} /></label>
          <label>Test command<input name="commands_test" value={form.commands_test} onChange={handleChange} /></label>
          <label>Lint command<input name="commands_lint" value={form.commands_lint} onChange={handleChange} /></label>
          <label>Build command<input name="commands_build" value={form.commands_build} onChange={handleChange} /></label>
          <label>Dev command<input name="commands_dev" value={form.commands_dev} onChange={handleChange} /></label>
          <label>Architecture Manager agent<input name="agent_architecture_manager" value={form.agent_architecture_manager} onChange={handleChange} /></label>
          <label>Sprint Leader agent<input name="agent_sprint_leader" value={form.agent_sprint_leader} onChange={handleChange} /></label>
          <label>Coder agent<input name="agent_coder" value={form.agent_coder} onChange={handleChange} /></label>
          <label>Reviewer agent<input name="agent_reviewer" value={form.agent_reviewer} onChange={handleChange} /></label>
          <label>Watch include<input name="watch_include" placeholder="src/**, lib/**" value={form.watch_include} onChange={handleChange} /></label>
          <label>Watch exclude<input name="watch_exclude" placeholder="node_modules/**, dist/**" value={form.watch_exclude} onChange={handleChange} /></label>
          <label>Metadata (JSON)<input name="metadata" placeholder='{"team":"core"}' value={form.metadata} onChange={handleChange} /></label>
        </div>
        {displayError && <p id="project-edit-error" className="agent-form-error" role="alert" data-error="field">{displayError}</p>}
        <div className="agent-modal-actions"><button className="history-button" type="button" onClick={onClose} disabled={saving}>Cancel</button><button className="history-button agent-submit-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button></div>
      </form>
    </div>
  </Dialog>;
}

// Business purpose: presents a confirmation dialog before removing a project, explicitly informing the operator that removal only unregisters the project from NodeForge's managed list and preserves all files on disk.
// Technical description: renders a confirmation Dialog displaying the project name, root, explicit file-preservation notice, backend error alert if deletion fails, and Cancel/Confirm buttons.
export function ProjectDeleteModal({ project, deleting, error, onClose, onConfirm }) {
  if (!project) return null;
  const name = project.name || project.project_id;
  return <Dialog open={Boolean(project)} onClose={() => { if (!deleting) onClose(); }} labelledBy="project-delete-title" variant="confirmation" panelStyle={{ width: "min(480px, calc(100vw - 32px))", borderRadius: 0, background: "var(--app-panel)" }}>
    <div className="agent-modal project-delete-modal">
      <header><div><p className="eyebrow">PROJECT MANAGEMENT</p><h2 id="project-delete-title">Remove project</h2></div><button className="agent-modal-close" type="button" aria-label="Close" onClick={onClose} disabled={deleting}>×</button></header>
      <p className="project-delete-notice">Removing <strong>{name}</strong> (<code>{project.root}</code>) only removes it from the managed project list. All project files and directories on disk are preserved and will not be deleted.</p>
      {error && <p id="project-delete-error" className="agent-form-error" role="alert" data-error="field">{error}</p>}
      <div className="agent-modal-actions">
        <button className="history-button" type="button" onClick={onClose} disabled={deleting}>Cancel</button>
        <button className="history-button danger" type="button" onClick={() => onConfirm(project)} disabled={deleting}>{deleting ? "Removing…" : "Confirm remove"}</button>
      </div>
    </div>
  </Dialog>;
}
