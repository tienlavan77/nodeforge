// Mount project workspace state only after validating the requested or remembered project identity.
"use client";
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
  // A directory request that fails outright means the Control API is unreachable; the page keeps its own interface instead of a blocking state screen.
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    let active = true;
    setAdmitted(null); setError(null); setUnreachable(false);
    // Resolve explicit deep links and tab-local selections against the current admitted directory.
    async function load() {
      // Re-admission after a recovered API must replace stale errors, so clear them before each attempt.
      if (active) setError(null);
      try { await refreshProjects(); }
      catch { if (active) setUnreachable(true); return; }
      if (!active) return;
      setUnreachable(false);
      try {
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
    // Re-run the full admission whenever the window regains focus so a restarted API recovers the workspace automatically.
    window.addEventListener("focus", load);
    return () => { active = false; window.removeEventListener("focus", load); };
  }, [projectId]);

  // While the first admission attempt is still resolving, show the loading status without a navigation button.
  if (!error && !unreachable && !selection.error && !admitted) return <main className="project-workspace-state"><p role="status">Opening project…</p></main>;
  // Keep the page's existing interface when the API cannot be reached; project-bound operations surface their own recoverable errors within the page.
  if (unreachable || (!error && admitted && selection.projectId === admitted)) return <Fragment key={selection.generation}>{children}</Fragment>;
  return <main className="project-workspace-state">
    <p role={error || selection.error ? "alert" : "status"}>{error || selection.error || "This project is unavailable. Choose an available project."}</p>
  </main>;
}
