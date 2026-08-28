import ProjectLogPreview from "../components/ProjectLogPreview";

export default function HomePage() {
  return (
    <main className="grid min-h-screen place-items-center bg-red-500 p-8 text-white">
      <div><p className="text-lg font-semibold">NodeForge Next.js scaffold</p><ProjectLogPreview /></div>
    </main>
  );
}
