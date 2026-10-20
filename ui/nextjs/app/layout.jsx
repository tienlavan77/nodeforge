// Root layout with global styles and metadata.
import "./globals.css";
import "./tailwind.css";
import { ProjectRouteBoundary } from "../components/project-route-boundary.jsx";

export const metadata = {
  title: "NodeForge",
  description: "NodeForge Next.js UI migration workspace",
};

// Root layout wrapping the app with global styles.
export default function RootLayout({ children }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <body>

        <ProjectRouteBoundary>{children}</ProjectRouteBoundary>
      </body>
    </html>
  );
}
