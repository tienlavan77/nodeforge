// Reuse System Engineer conversations under an explicitly admitted project route.
"use client";
import { useParams, usePathname } from "next/navigation";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import SystemPage from "../../system/page.jsx";
import { resolveActiveProjectId } from "../../../lib/home-page-constants.js";

// Business purpose: mounts the System Engineer workspace scoped to the dynamic `projectId` in the route URL (`/[projectId]/system`).
// Technical description: resolves `projectId` from route params or pathname and passes it as a prop and key to `SystemPage`.
export default function ProjectSystemPage({ projectId: propProjectId } = {}) {
  const params = useParams();
  const pathname = usePathname();
  const routeProjectId = Array.isArray(params?.projectId) ? params.projectId[0] : params?.projectId;
  const projectId = resolveActiveProjectId({ explicitProjectId: propProjectId, routeProjectId, pathname });
  return <SystemPage key={projectId} projectId={projectId} />;
}
