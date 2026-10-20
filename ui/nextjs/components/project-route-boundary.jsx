// Keep the public project directory independent from project-bound conversation state.
"use client";
import { usePathname } from "next/navigation";
import { projectIdFromPath } from "../lib/project-navigation.js";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ProjectWorkspace } from "./project-workspace.jsx";

// Admit the project named in the URL before mounting Architecture or other workspace pages.
export function ProjectRouteBoundary({ children }) {
  const pathname = usePathname();
  if (pathname === "/") return children;
  return <ProjectWorkspace projectId={projectIdFromPath(pathname)}>{children}</ProjectWorkspace>;
}
