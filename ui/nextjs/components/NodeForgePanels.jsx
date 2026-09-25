// NodeForge panels aggregating dashboard, chat, history and ticket modals.
/* TICKET-PROJECT-NODEFORGE-1789479214703: English ticket regeneration via Vietnamese source context -> sprint leader */
"use client";
import { useState } from "react";
import { createNodeClient, detectMessageIntent, MESSAGE_INTENTS } from "../lib/node-client.js";
import { validateSprintPlan } from "../lib/sprint-plan-validator.js";
import { MessageContent } from "./conversation-message-content.jsx";
import { AgentProcessStatus, PanelHeader } from "./agent-panel-header.jsx";
import { SprintPlanDashboard } from "./sprint-plan-panels.jsx";
import { AgentSettingsOverlay, HistoryOverlay } from "./agent-workspace-overlays.jsx";
import { ArchitectureArtifacts, ArchitectureManagerSelector, Message } from "./architecture-workspace-panels.jsx";
export { AgentProcessStatus, MessageContent, PanelHeader, SprintPlanDashboard, AgentSettingsOverlay, HistoryOverlay, ArchitectureArtifacts, ArchitectureManagerSelector, Message };

const AGENTS = [
  { id: "architecture-manager", label: "Architecture Manager", short: "AM", tone: "violet" },
  { id: "sprint-leader", label: "Sprint Leader", short: "SL", tone: "cyan" },
  { id: "builder", label: "Builder", short: "BU", tone: "amber" },
  { id: "reviewer", label: "Reviewer", short: "RV", tone: "green" }
];
const PROJECT_ID = "PROJECT-NODEFORGE";
const ARCHITECTURE_CONVERSATION_ID = "CONV-ARCHITECTURE";
const CONVERSATIONS = {
  "architecture-manager": "CONV-ARCHITECTURE",
  "sprint-leader": "CONV-SPRINT-LEADER",
  "builder": "CONV-BUILDER",
  "reviewer": "CONV-REVIEWER"
};
const CHAT_PAGE_SIZE = 10;


export function ConversationModal({ client, projectId = PROJECT_ID, agentId, onClose, onCreated }) {
  const [title, setTitle] = useState("");
  const [state, setState] = useState("idle");
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    if (!title) return;
    setState("creating");
    setError("");
    try {
      const conversation = await client.createConversation({ projectId, agentId, title });
      setState("created");
      await onCreated?.(conversation);
    } catch (failure) {
      setState("error");
      setError(failure?.message ?? String(failure));
    }
  }
  return <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Create Conversation">
    <section className="settings-modal">
      <header><div><h2>Create Conversation</h2><p>Start a new conversation with the selected agent.</p></div><button type="button" onClick={onClose} aria-label="Close conversation dialog">&#215;</button></header>
      <form onSubmit={submit}>
        <label htmlFor="conversation-title">Conversation title<input id="conversation-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Enter a conversation title" /></label>
        <div className="settings-actions"><button type="submit" disabled={!title || state === "creating"}>Create</button><button type="button" onClick={onClose}>Cancel</button></div>
      </form>
      {error && <p role="alert">{error}</p>}
      {state === "created" && <p role="status">Conversation created.</p>}
    </section>
  </div>;
}

// Dialog for uploading a sprint plan JSON file.
export function UploadSprintPlanDialog({ client, onClose, onUploaded }) {
  const [fileName, setFileName] = useState("");
  const [plan, setPlan] = useState(null);
  const [errors, setErrors] = useState([]);
  const [state, setState] = useState("");
  async function choose(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name); setPlan(null); setState("");
    try {
      const parsed = JSON.parse(await file.text());
      const nextErrors = validateSprintPlan(parsed);
      setErrors(nextErrors);
      if (!nextErrors.length) setPlan(parsed);
    } catch (error) {
      console.error("Unable to parse sprint plan JSON", error);
      setErrors(["File must contain valid JSON."]);
    }
  }
  function drop(event) {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    choose({ target: { files: [file] } });
  }
  async function submit() {
    if (!plan) return;
    setState("Uploading…");
    try { await client.uploadSprintPlan(plan.project_id, plan); await onUploaded?.(); setState("Uploaded successfully."); }
    catch (error) { setState(`Error: ${error.message}`); }
  }
  return <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Upload Sprint Plan"><section className="settings-modal upload-modal"><header><div><h2>Upload Sprint Plan</h2><p>Select a sprint-plan JSON file and preview it before submitting.</p></div><button onClick={onClose} aria-label="Close upload dialog">&#215;</button></header><label className="upload-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={drop}><input type="file" accept=".json,application/json" onChange={choose} aria-label="Sprint plan JSON file" /><strong>Drop sprint plan JSON here</strong><span>or click to browse</span></label>{fileName && <small className="upload-file">{fileName}</small>}{errors.length > 0 && <div className="upload-errors" role="alert">{errors.map((error) => <p key={error}>{error}</p>)}</div>}{plan && <div className="upload-preview"><strong>{plan.id}</strong><p>{plan.objective}</p><span>Roadmap: {plan.roadmap_id} · Project: {plan.project_id}</span><span>{plan.tickets.length} tickets · {plan.exit_criteria.length} exit criteria</span></div>}<div className="settings-actions"><button onClick={submit} disabled={!plan || state === "Uploading…"}>Upload</button><button onClick={onClose}>Cancel</button></div>{state && <p aria-live="polite">{state}</p>}</section></div>;
}

// Controls for submitting human governance decisions.
export function InlineDecisionControls({ client, onWorkspaceChanged, workspace }) {
  const [reason, setReason] = useState("");
  const [result, setResult] = useState("");
  const pending = getPendingArchitectureProposal(workspace);
  async function submit(decision) {
    if (!pending) return;
    const proposalId = pending.id;
    if (["REJECT", "CHANGE_REQUEST"].includes(decision) && !reason.trim()) { setResult("Reason is required."); return; }
    try {
      await client.postHumanDecision({ projectId: PROJECT_ID, decisionId: `HUMAN-${Date.now()}`, actor: "project-owner", proposalId, decision, reason: reason.trim(), correlationId: `CORR-DECISION-${Date.now()}` });
      setReason(""); setResult(labelForDecision(decision)); onWorkspaceChanged();
    } catch (error) { setResult(error.message); }
  }
  // Once a proposal is decided, keep the result in History rather than the chat composer.
  if (!pending) return null;
  return <section className="decision-actions" aria-label="Human Decision"><h3>Human Decision</h3><p>{pending.title ?? pending.id}</p><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for reject/change request" aria-label="Decision reason" /><div><button onClick={() => submit("APPROVE")}>Approve</button><button onClick={() => submit("CHANGE_REQUEST")}>Request Changes</button><button onClick={() => submit("REJECT")}>Reject</button></div>{result && <small>{result}</small>}</section>;
}

// Finds the pending architecture proposal awaiting decision.
function getPendingArchitectureProposal(workspace) {
  const decisions = workspace?.decisions ?? [];
  const completed = new Set(decisions.filter((item) => item.type === "human_governance").map((item) => item.proposal_id));
  return decisions.find((item) => item.type !== "human_governance" && item.status === "proposed" && !completed.has(item.id)) ?? null;
}

// Returns a display label for a governance decision.
function labelForDecision(decision) {
  if (decision === "APPROVE") return "✓ Approved";
  if (decision === "CHANGE_REQUEST") return "↻ Change Requested";
  if (decision === "REJECT") return "✕ Rejected";
  return "Decision recorded";
}

// Converts a raw Node message into a displayable chat message.
export function toDisplayMessage(message) {
  const isOwner = message.sender?.role === "project_owner";
  const text = message.payload?.text
    ?? message.payload?.content
    ?? formatTicketResponse(message)
    ?? (message.message_type === "architecture.working" ? "Architecture Manager is working…" : message.message_type === "architecture.message.received" ? "Architecture plan recorded in Node." : message.message_type);
  return { id: message.message_id, correlation_id: message.correlation_id, message_type: message.message_type, from: isOwner ? "owner" : message.message_type.includes("error") ? "system" : "agent", text, time: new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
}

// Formats a ticket message payload into readable text.
function formatTicketResponse(message) {
  const payload = message.payload ?? {};
  if (message.message_type === "ticket.creation" || message.message_type === "ticket.status") {
    if (payload.error) return payload.error;
    if (message.message_type === "ticket.input_rejected") return payload.error ?? "Ticket đang chạy; hãy chờ hoàn tất rồi thử lại.";
    if (payload.status === "syntax_error") return payload.error ?? "Không nhận diện được ticket id.";
    if (payload.status === "created" || payload.create_ticket) {
      const ticket = payload.ticket ?? payload;
      return `Ticket ${ticket.id ?? "mới"} đã được tạo và lưu vào roadmap.`;
    }
    if (payload.status) return `Ticket ${payload.ticket_id ?? ""}: ${payload.status}`.trim();
  }
  if (message.message_type?.includes("error")) return payload.error ?? payload.message ?? "Node báo lỗi khi xử lý yêu cầu.";
  return null;
}
