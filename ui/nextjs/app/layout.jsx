// Root layout with global styles and metadata.
import "./globals.css";
import "./tailwind.css";
import { ProjectWorkspace } from "../components/project-workspace.jsx";

export const metadata = {
  title: "NodeForge",
  description: "NodeForge Next.js UI migration workspace",
};

// Root layout wrapping the app with global styles.
export default function RootLayout({ children }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <body>

        <ProjectWorkspace>{children}</ProjectWorkspace>
      </body>
    </html>
  );
}
