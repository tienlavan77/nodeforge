// Provide project management and remount workspace state whenever its admitted identity changes.
"use client";
import { Fragment, useEffect, useState, useSyncExternalStore } from "react";
import { addProject, getProjectSelection, refreshProjects, removeProject, selectProject, subscribeProjectSelection } from "../lib/project-selection.js";

const initialSelection = { projects: [], projectId: null, generation: 0, loaded: false, error: null };

// Keep selection and addition available even when the selected project's workspace cannot be mounted.
export function ProjectWorkspace({ children }) {
  const selection = useSyncExternalStore(subscribeProjectSelection, getProjectSelection, () => initialSelection);
  const [root, setRoot] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    refreshProjects().catch((failure) => setError(failure.message));
    // Revalidate removals performed by another management client without polling project workloads.
    const refresh = () => { refreshProjects().catch((failure) => setError(failure.message)); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  // Surface lifecycle failures without discarding the user's root or selecting another project.
  async function manage(operation) {
    setBusy(true); setError(null);
    try { await operation(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  const selected = selection.projects.find((project) => project.project_id === selection.projectId);
  return <>
    <section aria-label="Project management" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: 12, maxWidth: "100%", boxSizing: "border-box", minWidth: 0 }}>
      <label style={{ minWidth: 0, maxWidth: "100%" }}>Project <select aria-label="Project" value={selection.projectId ?? ""} onChange={(event) => selectProject(event.target.value)} style={{ maxWidth: "100%", width: 220 }}>
        <option value="" disabled>Select a project</option>
        {selection.projects.map((project) => <option key={project.project_id} value={project.project_id}>{project.root}</option>)}
      </select></label>
      <form onSubmit={(event) => { event.preventDefault(); manage(async () => { await addProject(root.trim()); setRoot(""); }); }} style={{ display: "flex", flexWrap: "wrap", gap: 8, minWidth: 0, maxWidth: "100%" }}>
        <input aria-label="Project root" placeholder="Absolute project root" required value={root} onChange={(event) => setRoot(event.target.value)} style={{ width: 220, maxWidth: "100%", minWidth: 0, boxSizing: "border-box" }} />
        <button type="submit" disabled={busy}>Add project</button>
      </form>
      <button type="button" disabled={busy} onClick={() => manage(refreshProjects)}>Refresh projects</button>
      {selected && <button type="button" disabled={busy} onClick={() => manage(() => removeProject(selected.root))}>Remove project</button>}
      {(error || selection.error) && <p role="alert" style={{ flexBasis: "100%", overflowWrap: "anywhere", margin: 0 }}>{error || selection.error}</p>}
      {!selection.projectId && <p role="status" style={{ flexBasis: "100%", margin: 0 }}>{selection.loaded ? "Select an available project or add a project to continue." : "Loading projects…"}</p>}
    </section>
    {selection.projectId && <Fragment key={selection.generation}>{children}</Fragment>}
  </>;
}
