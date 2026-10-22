// Presents Architecture planning questions inside the selected conversation and restores answers through the shared project stream.
"use client";
import { useEffect, useMemo, useState } from "react";
import { ArchitectureClarificationCard } from "./architecture-clarification-card.jsx";
import { createArchitectureClarificationLoader, refreshArchitectureClarifications } from "../lib/architecture-clarification-loader.js";

// Connects the owner question wizard to durable Node sessions without adding another SSE connection or polling timer.
export function ArchitectureClarifications({ client, projectId, conversationId, agentId, planEvents, onPlanCreated }) {
  const [snapshot, setSnapshot] = useState({ status: "loading", sessions: [], error: null });
  const loader = useMemo(() => createArchitectureClarificationLoader({ client, projectId, conversationId, onState: setSnapshot }), [client, projectId, conversationId]);
  useEffect(() => {
    setSnapshot({ status: "loading", sessions: [], error: null });
    if (!conversationId) return undefined;
    let scheduled;
    // Coalesces lifecycle changes and postpones reconciliation until the owner returns to the tab.
    const refresh = () => { if (!scheduled && document.visibilityState !== "hidden") scheduled = setTimeout(() => { scheduled = null; if (document.visibilityState !== "hidden") void loader.load(); }, 100); };
    const unsubscribe = planEvents?.subscribe((event) => { if (refreshArchitectureClarifications(event, projectId, conversationId)) refresh(); });
    refresh(); document.addEventListener("visibilitychange", refresh);
    return () => { unsubscribe?.(); clearTimeout(scheduled); document.removeEventListener("visibilitychange", refresh); loader.cancel(); };
  }, [loader, planEvents, projectId, conversationId]);

  // Persists a versioned draft choice before showing it as durable progress.
  async function save(session, selections, notes, token, cancel) {
    loader.cancel();
    const next = await client.saveArchitectureChoices(projectId, conversationId, session, selections, notes, token, cancel);
    setSnapshot((current) => ({ ...current, sessions: current.sessions.map((item) => item.session_id === next.session_id ? next : item) }));
    return next;
  }

  // Continues the exact answered session, then reconciles its immutable plan result rather than assuming approval.
  async function confirm(session, token) {
    try {
      const result = await client.confirmArchitectureChoices(projectId, conversationId, session, token);
      if (result?.plan_id) await onPlanCreated?.(result);
    }
    finally { await loader.load(); }
  }

  // Restarts discovery for a changed input instead of reusing answers bound to the old file checksum.
  async function reanalyze(session) {
    const id = crypto.randomUUID();
    await client.postOwnerMessage({ projectId, conversationId, agentId, messageId: `MSG-REPLAN-${id}`, correlationId: `CORR-REPLAN-${id}`, text: `/plan ${session.source_path}` });
    await loader.load();
  }

  if (!conversationId) return null;
  return <div className="architecture-clarifications">
    {snapshot.error && <p role="alert">{snapshot.error} <button type="button" onClick={() => loader.load()}>Thử lại</button></p>}
    {snapshot.sessions.filter((session) => !["completed", "cancelled"].includes(session.status)).map((session) => <ArchitectureClarificationCard key={session.session_id} session={session} onSave={save} onConfirm={confirm} onReload={() => loader.load()} onReanalyze={reanalyze} />)}
  </div>;
}
