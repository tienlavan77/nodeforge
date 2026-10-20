// Render the existing Architecture workspace at its selected project URL.
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import ArchitectureWorkspace from "../../components/architecture-workspace.jsx";

// Keep project admission in the shared route boundary before mounting project clients.
export default function ProjectPage() {
  return <ArchitectureWorkspace />;
}
