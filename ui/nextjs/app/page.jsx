import Link from "next/link";
import NodeForgeApp from "./NodeForgeApp";

export default function HomePage() {
  return (
    <>
      <nav className="app-navigation" aria-label="Application navigation">
        <Link href="/agent">Agent Profile</Link>
      </nav>
      <NodeForgeApp />
    </>
  );
}
