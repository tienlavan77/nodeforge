// Serve the coding conversation workspace at the established /coding route.
import SystemPage from "../system/page.jsx";

// Render the Code workspace using the shared System Engineer conversation UI.
export default function CodingPage() {
  return <SystemPage sectionTitle="Code" />;
}
