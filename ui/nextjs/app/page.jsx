import Link from "next/link";
import NodeForgeApp from "./NodeForgeApp";

function HomeHeader() {
  return (
    <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4 shadow-sm sm:px-10" aria-label="Primary header">
      <Link href="/" className="group flex items-center gap-3" aria-label="NodeForge home">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-950 text-lg font-black tracking-tight text-cyan-300 shadow-sm transition-transform group-hover:-rotate-3">
          N
        </span>
        <span className="leading-none">
          <span className="block text-sm font-extrabold tracking-[0.18em] text-slate-950">NODEFORGE</span>
          <span className="mt-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Control room</span>
        </span>
      </Link>

      <Link
        href="/agent"
        className="inline-flex items-center gap-2 rounded-full bg-slate-950 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2"
      >
        Agents
        <span aria-hidden="true" className="text-cyan-300">-&gt;</span>
      </Link>
    </header>
  );
}

export default function HomePage() {
  return (
    <>
      <HomeHeader />
      <nav className="app-navigation" aria-label="Application navigation">
        <Link href="/agent">Agent Profile</Link>
      </nav>
      <NodeForgeApp />
    </>
  );
}
