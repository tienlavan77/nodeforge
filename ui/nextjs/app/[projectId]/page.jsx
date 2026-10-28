// Render the existing Architecture workspace at its selected project URL.
"use client";
import { useParams, usePathname } from "next/navigation";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import ArchitectureWorkspace from "../../components/architecture-workspace.jsx";
import { resolveActiveProjectId } from "../../lib/home-page-constants.js";

// Keep project admission in the shared route boundary before mounting project clients.
export default function ProjectPage({ projectId: propProjectId } = {}) {
  const params = useParams();
  const pathname = usePathname();
  const routeProjectId = Array.isArray(params?.projectId) ? params.projectId[0] : params?.projectId;
  const projectId = resolveActiveProjectId({ explicitProjectId: propProjectId, routeProjectId, pathname });
  return <ArchitectureWorkspace key={projectId} projectId={projectId} />;
}
