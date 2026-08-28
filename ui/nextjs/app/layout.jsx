import "./globals.css";
import "./tailwind.css";

export const metadata = {
  title: "NodeForge",
  description: "NodeForge Next.js UI migration workspace",
};

export default function RootLayout({ children }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
