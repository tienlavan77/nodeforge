// Open NodeForge with a project directory before mounting any project workspace.
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ProjectDirectory } from "../components/project-directory.jsx";

// Let owners choose the project whose Architecture conversation they want to open.
export default function HomePage() {
  return <ProjectDirectory />;
}
