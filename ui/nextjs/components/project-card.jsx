// Present an admitted project as a keyboard-accessible card using the agent directory's visual structure.
"use client";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import Link from "next/link";
import { projectArchitecturePath } from "../lib/project-navigation.js";
import { selectProject } from "../lib/project-selection.js";

// Open the project's Architecture workspace through its persisted identity.
export function ProjectCard({ project }) {
  const name = project.name || project.root.split("/").filter(Boolean).at(-1) || project.project_id;
  return <Link className="agent-directory-card project-card" href={projectArchitecturePath(project.project_id)} onClick={() => selectProject(project.project_id)} aria-label={`Open ${name}`}>
    <div className="agent-card-header"><strong>{name}</strong><span className="project-card-type">PROJECT</span></div>
    <div className="project-card-body">
      <span className="project-card-icon" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M5 12h15l5 6h18v22H5V12Z" /><path d="M5 18h38M16 29h16M24 25v8" /></svg></span>
      <span className="project-card-root" title={project.root}>{project.root}</span>
    </div>
    <div className="agent-card-footer"><span className="project-card-id">{project.project_id}</span><span className="project-card-open">Architecture <span aria-hidden="true">↗</span></span></div>
  </Link>;
}
