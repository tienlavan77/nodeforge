// Mount project workspace state only after validating the requested or remembered project identity.
"use client";
// eslint-disable-next-line no-unused-vars -- Fragment is rendered in JSX.
import { Fragment, useEffect, useState, useSyncExternalStore } from "react";
import { getProjectSelection, refreshProjects, selectProject, subscribeProjectSelection } from "../lib/project-selection.js";
import { readSelectedProject } from "../lib/project-navigation.js";
import { getIdeasSession } from "../lib/ideas-session.js";

const initialSelection = { projects: [], projectId: null, generation: 0, loaded: false, error: null };

// Preserve the original workspace layout without inserting a management toolbar above every page.
export function ProjectWorkspace({ children, projectId }) {
  const selection = useSyncExternalStore(subscribeProjectSelection, getProjectSelection, () => initialSelection);
  const [admitted, setAdmitted] = useState(null);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  // Keep an unconfirmed notebook save visible if admission removes the panel from the workspace.
  const ideasSession = getIdeasSession(projectId ?? admitted ?? "");
  const ideasState = useSyncExternalStore(ideasSession.subscribe, ideasSession.getSnapshot, ideasSession.getSnapshot);
  useEffect(() => {
    let active = true;
    setAdmitted(null); setError(null);
    // Resolve explicit deep links and tab-local selections against the current admitted directory.
    async function load() {
      // Re-admission after a recovered API must replace stale errors, so clear them before each attempt.
      if (active) setError(null);
      try { await refreshProjects(); }
      catch (failure) { if (active) setError(failure.message); return; }
      if (!active) return;
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
  }, [projectId, retry]);

  // A workspace that already rendered its admitted project must keep showing its last-known page when a later
  // refresh fails (API restart or outage); only a first admission that never produced data falls back to a notice.
  const heldProject = admitted && selection.projectId === admitted;
  if (heldProject) {
    const stale = Boolean(error || selection.stale);
    return <Fragment key={selection.generation}>
      <p role="status" aria-live="polite" className="project-workspace-stale" hidden={!stale}>Connection to the Node API was lost. Showing the last known state; some information may be out of date.</p>
      {children}
    </Fragment>;
  }
  // While the first admission attempt is still resolving, show the loading status without a navigation button.
  if (!error && !selection.error) return <main className="project-workspace-state"><p role="status">Opening project…</p></main>;
  return <main className="project-workspace-state">
    <p role="alert">{error || selection.error || "This project is unavailable. Choose an available project."}</p>
    {ideasState.uncertain && <p role="alert">Chưa xác nhận lưu ý tưởng. Bản nháp được giữ trong phiên UI; chọn lại project khi có thể để đối chiếu.</p>}
    <button type="button" onClick={() => setRetry((current) => current + 1)}>Retry</button>
  </main>;
}
