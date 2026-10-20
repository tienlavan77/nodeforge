// Mount project workspace state only after validating the requested or remembered project identity.
"use client";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import Link from "next/link";
// eslint-disable-next-line no-unused-vars -- Fragment is rendered in JSX.
import { Fragment, useEffect, useState, useSyncExternalStore } from "react";
import { getProjectSelection, refreshProjects, selectProject, subscribeProjectSelection } from "../lib/project-selection.js";
import { readSelectedProject } from "../lib/project-navigation.js";

const initialSelection = { projects: [], projectId: null, generation: 0, loaded: false, error: null };

// Preserve the original workspace layout without inserting a management toolbar above every page.
export function ProjectWorkspace({ children, projectId }) {
  const selection = useSyncExternalStore(subscribeProjectSelection, getProjectSelection, () => initialSelection);
  const [admitted, setAdmitted] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let active = true;
    setAdmitted(null); setError(null);
    // Resolve explicit deep links and tab-local selections against the current admitted directory.
    async function load() {
      try {
        await refreshProjects();
        if (!active) return;
        const current = getProjectSelection();
        const soleProject = current.projects.length === 1 ? current.projects[0].project_id : null;
        const target = projectId ?? readSelectedProject() ?? current.projectId ?? soleProject;
        if (!target) throw new Error("Choose a project to open its workspace.");
        if (!getProjectSelection().projects.some((project) => project.project_id === target)) throw new Error("This project is unavailable. Choose an available project.");
        selectProject(target);
        setAdmitted(target);
      } catch (failure) { if (active) setError(failure.message); }
    }
    void load();
    // Detect externally removed projects while preserving the current page on ordinary focus events.
    const refresh = () => { refreshProjects().catch((failure) => { if (active) setError(failure.message); }); };
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, [projectId]);

  if (!error && admitted && selection.projectId === admitted) return <Fragment key={selection.generation}>{children}</Fragment>;
  return <main className="project-workspace-state">
    <p role={error || selection.error ? "alert" : "status"}>{error || selection.error || (admitted ? "This project is unavailable. Choose an available project." : "Opening project…")}</p>
    <Link className="history-button" href="/">Back to projects</Link>
  </main>;
}
