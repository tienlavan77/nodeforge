// Root layout with global styles and metadata.
import "./globals.css";
import "./tailwind.css";

export const metadata = {
  title: "NodeForge",
  description: "NodeForge Next.js UI migration workspace",
};

// Root layout wrapping the app with global styles.
export default function RootLayout({ children }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <body>

        {children}
      </body>
    </html>
  );
}
