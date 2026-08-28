"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Dashboard from "../components/Dashboard";
import HistoryView from "../components/HistoryView";
import ProjectLogPreview from "../components/ProjectLogPreview";
import StreamingPanel from "../components/StreamingPanel";
import { createNodeClient } from "../../src/services/node-client.js";

const PROJECT_ID = "PROJECT-NODEFORGE";
const AGENTS = [
  { id: "architecture-manager", conversation_id: "CONV-ARCHITECTURE" },
  { id: "sprint-leader", conversation_id: "CONV-SPRINT-LEADER" },
  { id: "builder", conversation_id: "CONV-BUILDER" },
  { id: "reviewer", conversation_id: "CONV-REVIEWER" },
];
const conversations = Object.fromEntries(AGENTS.map((agent) => [agent.id, agent.conversation_id]));

export default function HomePage() {
  const client = useMemo(() => createNodeClient(), []);
  const [dashboard, setDashboard] = useState(null);
  const [entries, setEntries] = useState([]);
  const [state, setState] = useState("loading");
  const loadDashboard = useCallback(async () => {
    try { setDashboard(await client.getProjectDashboard(PROJECT_ID)); setState("ready"); } catch { setState("error"); }
  }, [client]);
  const loadHistory = useCallback(async () => {
    const result = await client.getConversationAuditHistory({ projectId: PROJECT_ID, limit: 25, order: "desc" });
    setEntries(result?.items ?? []);
    return result;
  }, [client]);
  useEffect(() => { loadDashboard(); loadHistory().catch(() => undefined); }, [loadDashboard, loadHistory]);

  return <main className="min-h-screen bg-red-500 p-8 text-white"><header><h1 className="text-2xl font-bold">NodeForge</h1><p>Next.js workspace UI</p></header><section className="mt-6 rounded bg-white p-6 text-black"><h2 className="text-xl font-semibold">Dashboard</h2>{state === "loading" && <p>Loading dashboard…</p>}{state === "error" && <p className="error">Node could not load the Project Dashboard.</p>}{state === "ready" && <Dashboard dashboard={dashboard} />}</section><div className="mt-6 rounded bg-white p-6 text-black"><HistoryView loadHistory={loadHistory} /></div><div className="mt-6 rounded bg-white p-6 text-black"><ProjectLogPreview entries={entries} /></div><div className="mt-6 rounded bg-slate-950 p-6"><StreamingPanel client={client} agents={AGENTS} conversations={conversations} projectId={PROJECT_ID} /></div></main>;
}
