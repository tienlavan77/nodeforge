// Let owners choose or add an admitted project before opening an Architecture workspace.
"use client";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { NodeForgeHeader } from "./NodeForgeHeader.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { Dialog } from "./Dialog.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ProjectCard } from "./project-card.jsx";
import { addProject, clearProjectSelection, getProjectSelection, refreshProjects, subscribeProjectSelection } from "../lib/project-selection.js";

const initialSelection = { projects: [], loaded: false, error: null };

// Render project cards and recoverable directory errors without mounting project-bound chat clients.
export function ProjectDirectory() {
  const selection = useSyncExternalStore(subscribeProjectSelection, getProjectSelection, () => initialSelection);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [root, setRoot] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  // Refresh the actual runtime directory while keeping a failed request visible and retryable.
  async function load() {
    setLoading(true); setError("");
    try { await refreshProjects({ selectInitial: false }); }
    catch (failure) { setError(failure.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { clearProjectSelection(); void load(); }, []);

  // Add a root through the existing governed lifecycle operation, then show its project card.
  async function submit(event) {
    event.preventDefault(); setSaving(true); setFormError("");
    try { await addProject(root.trim()); setAdding(false); setRoot(""); setError(""); }
    catch (failure) { setFormError(failure.message); }
    finally { setSaving(false); }
  }

  return <div className="app-shell app-shell-control-room projects-directory-shell">
    <NodeForgeHeader title="NODEFORGE" subtitle="Choose your workspace" project={null} actions={<Link className="history-button" href="/agents">Agents</Link>} />
    <main className="agents-directory projects-directory" aria-label="Projects directory">
      <div className="agents-directory-heading projects-directory-heading">
        <div><p className="eyebrow">YOUR WORKSPACES</p><h1>Projects</h1><p className="projects-directory-description">Choose a project to open its Architecture workspace.</p></div>
        <button className="history-button" type="button" onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
      </div>
      {error && <div className="projects-directory-error" role="alert"><strong>Could not load projects</strong><p>{error}</p><button className="history-button" type="button" onClick={load} disabled={loading}>Try again</button></div>}
      {loading && !selection.projects.length && <p role="status" className="agents-directory-state">Loading projects…</p>}
      {!loading && !error && !selection.projects.length && <p className="agents-directory-state">No projects yet. Add a project to get started.</p>}
      <div className="agents-card-grid projects-card-grid">
        {!error && selection.projects.map((project) => <ProjectCard key={project.project_id} project={project} />)}
        <button className="agent-directory-card agent-add-card project-add-card" type="button" aria-label="Add project" onClick={() => { setFormError(""); setAdding(true); }}><span aria-hidden="true">＋</span><strong>Add project</strong><small>Open another workspace</small></button>
      </div>
    </main>
    <Dialog open={adding} onClose={() => { if (!saving) setAdding(false); }} labelledBy="project-add-title" panelStyle={{ width: "min(520px, calc(100vw - 32px))", borderRadius: 0, background: "var(--app-panel)" }}>
      <div className="agent-modal project-add-modal">
        <header><div><p className="eyebrow">WORKSPACE</p><h2 id="project-add-title">Add project</h2></div><button className="agent-modal-close" type="button" aria-label="Close" onClick={() => setAdding(false)} disabled={saving}>×</button></header>
        <form onSubmit={submit}>
          <label>Project folder<input required placeholder="/home/data/sites/my-project" value={root} onChange={(event) => setRoot(event.target.value)} /></label>
          {formError && <p className="agent-form-error" role="alert">{formError}</p>}
          <div className="agent-modal-actions"><button className="history-button" type="button" onClick={() => setAdding(false)} disabled={saving}>Cancel</button><button className="history-button agent-submit-button" type="submit" disabled={saving}>{saving ? "Adding…" : "Add project"}</button></div>
        </form>
      </div>
    </Dialog>
  </div>;
}
