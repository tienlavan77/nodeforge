"use client";
/* Legacy Vite parity copy: retain dormant components until the Next UI is fully consolidated. */
/* eslint-disable no-unused-vars, no-undef */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createNodeClient, detectMessageIntent, normalizeTicketInput, MESSAGE_INTENTS } from "../lib/node-client.js";
import { validateSprintPlan } from "../lib/sprint-plan-validator.js";

const AGENTS = [
  { id: "architecture-manager", label: "Architecture Manager", short: "AM", tone: "violet" },
  { id: "sprint-leader", label: "Sprint Leader", short: "SL", tone: "cyan" },
  { id: "builder", label: "Builder", short: "BU", tone: "amber" },
  { id: "reviewer", label: "Reviewer", short: "RV", tone: "green" }
];

function App() {
  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">N</div><div><div className="brand-name">NODE CONTROL ROOM</div><div className="brand-sub">Human governance surface</div></div></div>
      <div className="topbar-meta"><span className="connection"><span className="live-dot" /> NODE ONLINE</span><span className="divider" /><span className="project-label">PROJECT <strong>NODEFORGE</strong></span><button className="history-button" onClick={() => setUploadOpen(true)}>Upload Sprint Plan</button><button className="history-button" onClick={() => setHistoryOpen(true)}>History</button><button className="history-button">Agents</button><button className="icon-button" title="Open settings" aria-label="Open settings">&#9881;</button></div>
    </header>
  </div>;
}

export default App;
