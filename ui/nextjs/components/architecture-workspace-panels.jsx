'use client';
// Render architecture governance and agent conversations in workspace panels.

import { MessageContent } from "./conversation-message-content.jsx";
import { PanelHeader } from "./agent-panel-header.jsx";

const PROJECT_ID = "PROJECT-NODEFORGE";

// CODEX-DOC-002: Project Chat target selector — only agents with the exact
// "Architecture Manager" role and enabled === true are selectable; the selected
// agent id is kept in UI state and invalid ids can never be dispatched to.
function enabledArchitectureManagers(agents = []) {
  return agents.filter((candidate) => candidate?.role === "Architecture Manager" && candidate.enabled === true && candidate.id);
}

// Dropdown for selecting an enabled Architecture Manager.
export function ArchitectureManagerSelector({ agents = [], value, onChange }) {
  const managers = enabledArchitectureManagers(agents);
  const selected = managers.some((candidate) => candidate.id === value) ? value : "";
  const emptyState = "No enabled Architecture Manager agents";
  return <label className="architecture-manager-selector" htmlFor="architecture-manager-select">
    <span>Architecture Manager</span>
    <select id="architecture-manager-select" value={selected} onChange={(event) => {
      const next = managers.find((candidate) => candidate.id === event.target.value);
      onChange?.(next?.id ?? "");
    }} aria-label="Select Architecture Manager" disabled={!managers.length}>
      <option value="">{managers.length ? "Select an Architecture Manager" : emptyState}</option>
      {managers.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name ?? candidate.label ?? candidate.id}{candidate.identity ? ` (${candidate.identity})` : ""}</option>)}
    </select>
  </label>;
}

// Displays the proposal awaiting human decision.
export function ArchitectureArtifacts({ workspace }) {
  const proposal = getPendingArchitectureProposal(workspace);
  if (!proposal) return null;
  return <aside className="architecture-artifacts pending-proposal" aria-label="Proposal awaiting human decision">
    <div className="workspace-section"><h3>Proposal Awaiting Decision</h3><div className="workspace-card"><strong>{proposal.title ?? proposal.id}</strong><p>{proposal.decision}</p><span>Architecture Manager proposal</span></div></div>
  </aside>;
}

// Finds the pending architecture proposal awaiting decision.
function getPendingArchitectureProposal(workspace) {
  const decisions = workspace?.decisions ?? [];
  const completed = new Set(decisions.filter((item) => item.type === "human_governance").map((item) => item.proposal_id));
  return decisions.find((item) => item.type !== "human_governance" && item.status === "proposed" && !completed.has(item.id)) ?? null;
}

// Displays a single chat message row.
export function Message({ message }) {
  const streaming = message.stream === true;
  const rowClass = `message-row natural-message ${message.from === "owner" ? "owner" : `agent${streaming ? " streaming" : ""}`}`;
  return <div id={`msg-${message.id}`} className={rowClass} data-message-id={message.id} data-correlation-id={message.correlation_id ?? ""} data-message-type={message.message_type ?? ""} data-role={message.from} data-timestamp={message.timestamp ?? ""}><MessageContent text={message.text} /><time dateTime={message.timestamp ?? ""} title={message.timestamp ?? ""}>{message.time}</time></div>;
}
