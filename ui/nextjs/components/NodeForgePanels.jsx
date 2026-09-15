"use client";
/* Legacy Vite parity copy: retain dormant components until the Next UI is fully consolidated. */
/* eslint-disable no-unused-vars, no-undef */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createNodeClient, detectMessageIntent, MESSAGE_INTENTS } from "../lib/node-client.js";
import { validateSprintPlan } from "../lib/sprint-plan-validator.js";

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
const PROVIDER_OPTIONS = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "custom", label: "Custom / OpenAI-compatible" }
];

function formatDateLabel(timestamp) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return "Today";
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function historyRecordToMessage(record) {
  const isOwner = record.kind === "owner";
  const raw = record.content;
  const text = eventTextForUser(record.type, raw) ?? raw?.text ?? raw?.content ?? formatTicketResponse({ message_type: record.type, payload: raw }) ?? (typeof raw === "string" ? raw : JSON.stringify(raw ?? ""));
  const from = isOwner ? "owner" : record.kind === "failure" ? "system" : record.kind === "agent" || record.kind === "completion" ? "agent" : isOwner ? "owner" : "agent";
  const ts = record.timestamp;
  const d = ts ? new Date(ts) : new Date();
  return { id: record.id, correlation_id: record.correlation_id, message_type: record.type, from, text: String(text ?? record.type), time: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), timestamp: ts, dateKey: Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10), dateLabel: ts ? formatDateLabel(ts) : "" };
}

function isInternalNodeEvent(type) {
  const value = String(type ?? "");
  return value.endsWith(".tool.result");
}

function eventTextForUser(type, payload = {}) {
  const value = String(type ?? "");
  const step = payload?.result?.step_name ?? payload?.step_name;
  if (value.endsWith(".message.progress") || value.endsWith(".progress")) return payload?.message ?? payload?.text ?? "Node đang xử lý…";
  if (value.endsWith(".working")) return "Builder đang làm việc…";
  if (value === "node.status_change") {
    const status = payload?.to ?? payload?.status;
    return status === "running" ? "Builder bắt đầu chạy ticket." : status === "reviewing" ? "Builder đã hoàn tất, đang chờ review." : status === "done" ? "Ticket đã hoàn tất." : status === "failed" ? `Ticket thất bại${payload?.error ? `: ${payload.error}` : "."}` : `Trạng thái ticket: ${status ?? "đã cập nhật"}.`;
  }
  if (value === "node.execution_step") return step ? `Đang xử lý: ${humanizeStep(step)}.` : "Đang xử lý một bước thực thi…";
  if (value === "node.command_result") return payload?.success === false ? `Bước thực thi thất bại${payload?.result?.error_code ? ` (${payload.result.error_code})` : "."}` : step ? `Đã hoàn tất: ${humanizeStep(step)}.` : "Đã hoàn tất một bước thực thi.";
  if (value === "git.status") return "Đã kiểm tra thay đổi Git.";
  if (value === "git.add") return "Đã chuẩn bị các file thay đổi cho commit.";
  if (value === "git.commit") return payload?.commit ? `Đã commit thay đổi (${payload.commit}).` : "Đã commit thay đổi.";
  if (value === "ticket.input_rejected") return payload?.error ?? "Ticket đang chạy; yêu cầu mới chưa được nhận.";
  return null;
}

function humanizeStep(step) {
  return String(step).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (char) => char.toUpperCase());
}
const MODEL_CATALOG = {
  codex: [
    { value: "gpt-5.6-sol", label: "GPT-5.6 Sol (default)" },
    { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "gpt-5.2", label: "GPT-5.2" }
  ],
  openai: [
    { value: "gpt-5.6", label: "GPT-5.6" },
    { value: "gpt-5.6-mini", label: "GPT-5.6 Mini" },
    { value: "gpt-5.1", label: "GPT-5.1" }
  ],
  anthropic: [
    { value: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
    { value: "claude-haiku-4.5", label: "Claude Haiku 4.5" }
  ],
  claude: [
    { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { value: "claude-opus-5", label: "Claude Opus 5" },
    { value: "claude-opus-4-8[1m]", label: "Claude Opus 4.8 [1m]" },
    { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { value: "claude-sonnet-4-0", label: "Claude Sonnet 4.0" },
    { value: "claude-opus-4-5", label: "Claude Opus 4.5" },
    { value: "claude-haiku-4-3", label: "Claude Haiku 4.3" },
    { value: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet (2024-10-22)" }
  ]
};

export function SprintPlanDashboard({ dashboard, client, onRefresh, onTicketDeleted, hideHeading = false }) {
  const [runningId, setRunningId] = useState(null);
  const [runMessage, setRunMessage] = useState("");
  const [runEvents, setRunEvents] = useState([]);
  const runStreamRef = useRef(null);
  const [viewSprint, setViewSprint] = useState(null);
  const [viewState, setViewState] = useState("idle");
  const [deleteMessage, setDeleteMessage] = useState("");
  const [highlightSprint, setHighlightSprint] = useState(null);
  const [collapsedSprints, setCollapsedSprints] = useState({});
  const knownSprintIds = useRef(null);
  useEffect(() => () => runStreamRef.current?.close?.(), []);
  const sprints = dashboard?.roadmap?.sprints ?? [];
  useEffect(() => {
    const ids = new Set(sprints.map((sprint) => sprint.id));
    if (knownSprintIds.current) {
      const created = sprints.find((sprint) => !knownSprintIds.current.has(sprint.id));
      if (created) {
        setHighlightSprint(created.id);
        const highlightTimer = setTimeout(() => setHighlightSprint(null), 3000);
        knownSprintIds.current = ids;
        return () => clearTimeout(highlightTimer);
      }
    }
    knownSprintIds.current = ids;
  }, [sprints]);
  if (!sprints.length) return null;

  async function handleRun(sprintId) {
    if (runningId) return;
    setRunningId(sprintId);
    setRunMessage("");
    try {
      const projectId = dashboard.project_id ?? PROJECT_ID;
      const result = await client.runSprintPlan(projectId, sprintId);
      setRunMessage(`Started ${result.sprint_id} — session ${result.session_id}`);
      setRunEvents(["Run accepted; waiting for agent events…"]);
      runStreamRef.current?.close?.();
      const conversationId = `CONV-BUILDER-${sprintId}`;
      runStreamRef.current = client.connectConversationStream({ projectId, conversationId, onMessage: (message) => {
        const type = message.message_type ?? "";
        const value = message.payload?.text ?? message.payload?.error ?? type;
        setRunEvents((events) => [...events.slice(-19), value]);
        if (type.endsWith(".message.received") || type.endsWith(".error") || type === "agent.completed" || type === "agent.failed" || type === "verification.result") setRunningId(null);
        if (type.endsWith(".error")) setRunMessage(`Run failed: ${value}`);
      }, onError: () => setRunMessage("Run stream disconnected; refresh history for final result.") });
    } catch (error) {
      const msg = String(error?.message ?? "");
      if (error.status === 409 || msg.includes("409") || msg.toLowerCase().includes("already running")) {
        setRunMessage(`Sprint ${sprintId} is already running (409).`);
      } else {
        setRunMessage(`Run failed: ${msg}`);
      }
      setRunningId(null);
    }
  }

  async function handleView(sprintId) {
    setViewState("loading");
    setViewSprint(null);
    try { setViewSprint(await client.getSprintPlan(dashboard.project_id ?? PROJECT_ID, sprintId)); setViewState("ready"); }
    catch (error) { setViewState(error.message); }
  }
  async function handleDelete(sprintId) {
    if (!window.confirm(`Delete ${sprintId}? This removes file and database records.`)) return;
    try { await client.deleteSprintPlan(dashboard.project_id ?? PROJECT_ID, sprintId); setDeleteMessage(`Deleted ${sprintId}.`); }
    catch (error) { setDeleteMessage(`Delete failed: ${error.message}`); }
  }

  return <section className="sprint-plan-dashboard" aria-label="Uploaded sprint plans">
    {!hideHeading && <h2>Roadmap Sprints</h2>}
    {sprints.map((sprint) => <article key={sprint.id} className={`sprint-item ${highlightSprint === sprint.id ? "is-new" : ""}`}>
      <div className="sprint-row"><div><strong>{sprint.id}</strong>{highlightSprint === sprint.id && <span className="sprint-new-badge">NEW</span>}</div><button className="sprint-collapse-button" onClick={() => setCollapsedSprints((state) => ({ ...state, [sprint.id]: !state[sprint.id] }))} aria-label="Toggle sprint tasks">{collapsedSprints[sprint.id] ? "+" : "−"}</button></div>
      <p>{sprint.objective ?? "No sprint objective provided."}</p>
      <small>{sprint.tasks?.filter((task) => task.status === "done").length ?? 0}/{sprint.tasks?.length ?? 0} tasks completed · {sprint.status ?? "planned"}</small>
      {!collapsedSprints[sprint.id] && <InlineAddTicketForm sprint={sprint} projectId={dashboard.project_id ?? PROJECT_ID} client={client} onCreated={onRefresh} />}
      {!collapsedSprints[sprint.id] && <div className="sprint-ticket-list" aria-label={`Tasks in ${sprint.id}`}>
        {sprint.tasks?.length ? sortSprintTickets(sprint.tasks).map((ticket) => <TicketCard key={ticket.id} ticket={{ ...ticket, sprint_id: sprint.id }} client={client} projectId={dashboard.project_id} onRefresh={onRefresh} onDeleted={onTicketDeleted} />) : <p className="dashboard-state">No tasks in this sprint.</p>}
      </div>}
      <div className="sprint-actions"><button className="sprint-view-button small" onClick={() => handleView(sprint.id)}>{viewSprint?.id === sprint.id && viewState === "ready" ? "Hide" : "View"}</button><button className="sprint-delete-button small" onClick={() => handleDelete(sprint.id)} disabled={Boolean(runningId) || sprint.status === "done"}>Delete</button><button className={`sprint-run-button small ${runningId === sprint.id ? "is-running" : ""}`} onClick={() => handleRun(sprint.id)} disabled={Boolean(runningId) || sprint.status === "done"}>{runningId === sprint.id ? "Running…" : "Run"}</button></div>
      {viewSprint?.id === sprint.id && <EntityDetailsModal title={viewSprint.id} state={viewState} onClose={() => { setViewState("idle"); setViewSprint(null); }}>{viewState === "ready" && <><p className="sprint-objective">{viewSprint.objective}</p><h3>Tickets ({viewSprint.tickets?.length ?? 0})</h3><div className="sprint-ticket-table">{(viewSprint.tickets ?? []).map((ticket) => <article key={ticket.id}><strong>{ticket.id}</strong><span>{ticket.title}</span><small>{ticket.priority ?? "normal"}</small></article>)}</div><h3>Exit Criteria</h3><ul>{(viewSprint.exit_criteria ?? []).map((item) => <li key={item}>{item}</li>)}</ul></>}</EntityDetailsModal>}
    </article>)}
    {runMessage && <p className="sprint-run-message" role="status" aria-live="polite">{runMessage}</p>}
    {runEvents.length > 0 && <div className="sprint-run-events" role="log" aria-label="Sprint run events">{runEvents.map((event, index) => <div key={`${index}-${event}`}><strong>Run</strong> {event}</div>)}</div>}
    {deleteMessage && <p className="sprint-run-message" role="status">{deleteMessage}</p>}
  </section>;
}

function InlineAddTicketForm({ sprint, projectId, client, onCreated }) {
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [state, setState] = useState("");
  async function submit(event) {
    event.preventDefault();
    setError("");
    setState("Creating…");
    try { await client.createTicket(projectId, content, sprint.id); setContent(""); await onCreated?.(); }
    catch (failure) { setError(failure.message); }
    finally { setState(""); }
  }
  return <form className="inline-add-ticket" onSubmit={submit}>
    <label htmlFor={`add-ticket-${sprint.id}`}>Add a ticket to this sprint</label>
    <div className="inline-add-ticket-row">
      <textarea id={`add-ticket-${sprint.id}`} value={content} onChange={(event) => { setContent(event.target.value); setError(""); }} rows="2" placeholder="Describe the ticket in Vietnamese or paste a draft…" aria-label={`New ticket for ${sprint.id}`} />
      <button type="submit" disabled={!content.trim() || Boolean(state)}>{state ? "Adding…" : "Add ticket"}</button>
    </div>
    {error && <p className="inline-add-ticket-error" role="alert">{error}</p>}
  </form>;
}

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
    } catch { setErrors(["File must contain valid JSON."]); }
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

function getPendingArchitectureProposal(workspace) {
  const decisions = workspace?.decisions ?? [];
  const completed = new Set(decisions.filter((item) => item.type === "human_governance").map((item) => item.proposal_id));
  return decisions.find((item) => item.type !== "human_governance" && item.status === "proposed" && !completed.has(item.id)) ?? null;
}

function labelForDecision(decision) {
  if (decision === "APPROVE") return "✓ Approved";
  if (decision === "CHANGE_REQUEST") return "↻ Change Requested";
  if (decision === "REJECT") return "✕ Rejected";
  return "Decision recorded";
}

export function HistoryOverlay({ client, onClose }) {
  const [agentId, setAgentId] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [type, setType] = useState("");
  const [state, setState] = useState("loading");
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const load = useCallback(async (cursor) => {
    setState("loading");
    try {
      const result = await client.getConversationAuditHistory({ projectId: PROJECT_ID, agentId: agentId || undefined, conversationId: conversationId || undefined, type: type || undefined, cursor });
      setItems((current) => cursor ? [...current, ...result.items] : result.items);
      setNextCursor(result.next_cursor);
      setState("ready");
    } catch { setState("error"); }
  }, [agentId, client, conversationId, type]);
  useEffect(() => { setItems([]); load(); }, [load]);
  return <div className="history-overlay" role="dialog" aria-modal="true" aria-label="Conversation and Audit History"><section className="history-modal"><header><div><h2>Conversation &amp; Audit History</h2><p>Read-only Node audit trail</p></div><button onClick={onClose} aria-label="Close history">&#215;</button></header><div className="history-filters"><select value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">All agents</option>{AGENTS.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}</select><input value={conversationId} onChange={(event) => setConversationId(event.target.value)} placeholder="conversation_id" /><input value={type} onChange={(event) => setType(event.target.value)} placeholder="message/event type" /></div><div className="history-list">{state === "loading" && <p>Loading persisted history from Node…</p>}{state === "error" && <p className="error">Node could not load history.</p>}{state === "ready" && !items.length && <p>No persisted conversation or audit records match this filter.</p>}{items.map((item) => <article key={`${item.kind}-${item.id}`} className={`history-item ${item.kind}`}><div><strong>{item.kind}</strong><span>{item.type}</span></div><p>{JSON.stringify(item.content)}</p><small>{item.timestamp} · {item.sender} → {item.receiver}{item.conversation_id ? ` · ${item.conversation_id}` : ""}{item.correlation_id ? ` · ${item.correlation_id}` : ""}</small></article>)}{nextCursor && <button className="history-more" onClick={() => load(nextCursor)}>Load more</button>}</div></section></div>;
}

export function AgentSettingsOverlay({ client, agent, onClose }) {
  const [profile, setProfile] = useState(null); const [url, setUrl] = useState(""); const [key, setKey] = useState(""); const [provider, setProvider] = useState("codex"); const [model, setModel] = useState(""); const [enabled, setEnabled] = useState(false); const [message, setMessage] = useState("");
  const models = MODEL_CATALOG[provider] ?? [];
  useEffect(() => { client.getAgentSettings().then((items) => { const item = items.find(({ agent_id: id }) => id === agent.id); if (item) { setProfile(item); setUrl(item.gateway_url ?? ""); setEnabled(Boolean(item.enabled)); setProvider(item.provider ?? "codex"); setModel(item.model ?? ""); } }).catch((error) => setMessage(`Error: ${error.message}`)); }, [agent.id, client]);
  function changeProvider(value) {
    const nextModels = MODEL_CATALOG[value] ?? [];
    setProvider(value);
    setModel(nextModels.some((item) => item.value === model) ? model : "");
  }
  async function save() { try { const item = await client.saveAgentSettings(agent.id, { agent_name: profile?.agent_name ?? agent.label, gateway_url: url, provider, model: models.length ? model : "", enabled, ...(key ? { api_key: key } : {}) }); setProfile(item); setKey(""); setMessage("Saved. API key remains masked in Node."); } catch (error) { setMessage(`Error: ${error.message}`); } }
  async function testConnection() { try { const result = await client.testAgentConnection(agent.id); setMessage(`Connected: ${result.status}`); } catch (error) { setMessage(`Failed: ${error.message}`); } }
  return <div className="settings-overlay" role="dialog" aria-modal="true"><section className="settings-modal"><header><h2>{agent.label} Settings</h2><button onClick={onClose} aria-label="Close Agent Settings">&#215;</button></header><label>Provider<select value={provider} onChange={(event) => changeProvider(event.target.value)} aria-label="Provider">{PROVIDER_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}</select></label><label>Model<select value={model} onChange={(event) => setModel(event.target.value)} aria-label="Model" disabled={!models.length}><option value="">{models.length ? "Select model" : "No model catalog for this provider"}</option>{models.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}</select></label><label>Gateway URL<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." /></label><label>API Key<input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder="********" autoComplete="new-password" /></label><label className="settings-check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enabled</label><div className="settings-actions"><button onClick={save}>Save Profile</button><button onClick={testConnection}>Test Connection</button></div>{profile?.api_key_masked && <small className="settings-mask">API key masked: {profile.api_key_masked}</small>}{message && <p aria-live="polite">{message}</p>}</section></div>;
}

export function toDisplayMessage(message) {
  const isOwner = message.sender?.role === "project_owner";
  const text = message.payload?.text
    ?? message.payload?.content
    ?? formatTicketResponse(message)
    ?? (message.message_type === "architecture.working" ? "Architecture Manager is working…" : message.message_type === "architecture.message.received" ? "Architecture plan recorded in Node." : message.message_type);
  return { id: message.message_id, correlation_id: message.correlation_id, message_type: message.message_type, from: isOwner ? "owner" : message.message_type.includes("error") ? "system" : "agent", text, time: new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
}

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

function mergeStreamMessage(messages, message) {
  if (messages.some((item) => item.id === message.message_id)) return messages;
  // Tool results and synthetic progress are private Node<->agent traffic; keep them in history/SSE replay but do not render in chat bubbles.
  if (message.message_type.endsWith(".tool.result")) return messages;
  if (message.message_type.endsWith(".message.progress") || message.message_type.endsWith(".progress")) return messages;
  if (message.message_type.endsWith(".working")) return messages;
  const isDelta = message.message_type.endsWith(".message.delta");
  const isCompletion = message.message_type.endsWith(".message.received");
  if (!isDelta && !isCompletion) return [...messages, toDisplayMessage(message)];
  const index = messages.findIndex((item) => item.from === "agent" && item.correlation_id === message.correlation_id && item.stream === true);
  if (index < 0) return [...messages, { ...toDisplayMessage(message), stream: true, text: message.payload?.text ?? "" }];
  const next = [...messages];
  const current = next[index];
  next[index] = { ...current, id: message.message_id, message_type: message.message_type, text: isDelta ? `${current.text}${message.payload?.text ?? ""}` : (message.payload?.text ?? current.text), stream: !isCompletion };
  return next;
}

// CODEX-DOC-002: Project Chat target selector — only agents with the exact
// "Architecture Manager" role and enabled === true are selectable; the selected
// agent id is kept in UI state and invalid ids can never be dispatched to.
function enabledArchitectureManagers(agents = []) {
  return agents.filter((candidate) => candidate?.role === "Architecture Manager" && candidate.enabled === true && candidate.id);
}

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

function ArchitecturePanel({ client, onWorkspaceChanged, onSettings, agent, workspace, agents = workspace?.agents ?? [], messages, draft, onDraft, onSend, onActivate, active }) {
  // CODEX-DOC-002: `agent` is the fixed panel identity, not the dispatch target.
  // The Project Chat target is the Architecture Manager chosen via
  // ArchitectureManagerSelector; `selectedAgent` is resolved from the enabled
  // manager list, so an invalid/stale id can never receive a dispatch.
  const conversationRef = useRef(null);
  const wasAtBottom = useRef(true);
  const managers = useMemo(() => enabledArchitectureManagers(agents), [agents]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const selectedAgent = managers.find((candidate) => candidate.id === selectedAgentId);
  useEffect(() => {
    setSelectedAgentId((current) => managers.some((candidate) => candidate.id === current) ? current : (managers[0]?.id ?? ""));
  }, [managers]);
  useEffect(() => {
    const element = conversationRef.current;
    if (element && wasAtBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages]);
  function send() {
    if (selectedAgent) onSend(selectedAgent);
  }
  return <article className={`agent-panel architecture-workspace ${active ? "is-active" : ""}`} onClick={onActivate}>
    <div className="agent-header"><ArchitectureManagerSelector agents={agents} value={selectedAgentId} onChange={setSelectedAgentId} /><button className="panel-menu" onClick={onSettings} title="Agent Settings" aria-label="Architecture Manager Agent Settings">&#9881;</button></div>
    <div className="architecture-conversation conversation natural-conversation" ref={conversationRef} onScroll={(event) => { const element = event.currentTarget; wasAtBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 56; }} role="log" aria-label="Architecture Manager messages">
      <div className="date-rule"><span>Conversation</span></div>
      {messages.map((message, index) => <Message key={message.id ?? `${message.time}-${index}`} message={message} />)}
      {agent.status === "WORKING" && <div className="working-status" role="status">Architecture Manager is working…</div>}
    </div>
    <form className="composer" onSubmit={(event) => { event.preventDefault(); send(); }}><textarea value={draft} onChange={(event) => onDraft(event.target.value)} onInput={(event) => { event.currentTarget.style.height = "auto"; event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} rows="2" placeholder="Message Architecture Manager..." aria-label="Message Architecture Manager" disabled={!selectedAgent} /><button type="submit" title="Send message" aria-label="Send message" disabled={!selectedAgent}>&#8593;</button></form>
  </article>;
}

export function ArchitectureArtifacts({ workspace }) {
  const proposal = getPendingArchitectureProposal(workspace);
  if (!proposal) return null;
  return <aside className="architecture-artifacts pending-proposal" aria-label="Proposal awaiting human decision">
    <div className="workspace-section"><h3>Proposal Awaiting Decision</h3><div className="workspace-card"><strong>{proposal.title ?? proposal.id}</strong><p>{proposal.decision}</p><span>Architecture Manager proposal</span></div></div>
  </aside>;
}

function HumanDecisionActions({ client, onWorkspaceChanged, proposal }) {
  const [reason, setReason] = useState("");
  const [result, setResult] = useState("");
  async function submit(decision) {
    if (!proposal) { setResult("No architecture proposal is available."); return; }
    if (["REJECT", "CHANGE_REQUEST"].includes(decision) && !reason.trim()) { setResult("Reason is required."); return; }
    try {
      await client.postHumanDecision({ projectId: PROJECT_ID, decisionId: `HUMAN-${Date.now()}`, actor: "project-owner", proposalId: proposal.id, decision, reason: reason.trim(), correlationId: `CORR-DECISION-${Date.now()}` });
      setReason(""); setResult(`${decision} recorded by Node.`); onWorkspaceChanged();
    } catch (error) { setResult(error.message); }
  }
  return <section className="decision-actions"><h3>Human Decision</h3><p>{proposal ? `Proposal: ${proposal.id}` : "Waiting for an architecture proposal."}</p><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for reject/change request" aria-label="Decision reason" /><div><button onClick={() => submit("APPROVE")}>Approve</button><button onClick={() => submit("REJECT")}>Reject</button><button onClick={() => submit("CHANGE_REQUEST")}>Change request</button></div>{result && <small>{result}</small>}</section>;
}

function ProjectDashboardPanel({ agent, dashboard, state, onActivate, active, onSettings, client, onRefresh }) {
  return <article className={`agent-panel dashboard-panel ${active ? "is-active" : ""}`} onClick={onActivate}>
    <PanelHeader agent={agent} onSettings={onSettings} />
    <div className="dashboard-content" aria-label="Project and Sprint Dashboard">
      {state === "loading" && <p className="dashboard-state">Loading dashboard from Node…</p>}
      {state === "error" && <p className="dashboard-state error">Node could not load the Project Dashboard.</p>}
      {state === "ready" && <DashboardData dashboard={dashboard} client={client} onRefresh={onRefresh} />}
    </div>
  </article>;
}

function DashboardData({ dashboard, client, onRefresh, onTicketDeleted }) {
  const sprints = dashboard?.roadmap?.sprints ?? [];
  if (!dashboard?.roadmap || !sprints.length) return <p className="dashboard-state">No roadmap or sprints have been published yet.</p>;
  return <>
    <div className="dashboard-overview"><span>ROADMAP <strong>{dashboard.roadmap.id}</strong></span><span>v{dashboard.roadmap.version}</span><span>{sprints.length} SPRINTS</span></div>
    {sprints.map((sprint) => <section className="dashboard-section" key={sprint.id}>
      <div className="sprint-row"><h3>{sprint.id}</h3><strong>{sprint.status ?? "planned"}</strong></div>
      <p>{sprint.objective ?? "No sprint objective provided."}</p>
      <small>{sprint.tasks?.filter((task) => task.status === "done").length ?? 0}/{sprint.tasks?.length ?? 0} tasks completed</small>
      {sprint.tasks?.length ? <div className="dashboard-tickets">{sprint.tasks.map((ticket) => <TicketCard key={ticket.id} ticket={{ ...ticket, sprint_id: sprint.id }} client={client} projectId={dashboard.project_id} onRefresh={onRefresh} onDeleted={onTicketDeleted} />)}</div> : <p className="dashboard-state">No tasks in this sprint.</p>}
    </section>)}
  </>;
}


function sortSprintTickets(tickets = []) {
  return tickets
    .map((ticket, index) => ({ ticket, index }))
    .sort((left, right) => Number(String(left.ticket.status ?? "").toLowerCase() === "done") - Number(String(right.ticket.status ?? "").toLowerCase() === "done") || left.index - right.index)
    .map(({ ticket }) => ticket);
}

function TicketCard({ ticket, client, projectId, onRefresh, onDeleted }) {
  const [message, setMessage] = useState("");
  const [viewOpen, setViewOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  async function view() {
    try { setDetail(await client.getTicket(projectId, ticket.id)); }
    catch { setDetail(ticket); }
    setViewOpen(true);
  }
  async function run({ fresh = false } = {}) {
    try {
      const response = await client.runTicket(projectId, ticket.id, { fresh });
      const status = response?.status;
      if (status === "accepted" || status === "started") setMessage(response?.resumed ? `Đã resume ${ticket.id} từ turn ${response.resumed_from_turn ?? "?"}, đang xử lý…` : `Đã gửi ${ticket.id} cho Supervisor, đang xử lý…`);
      else if (status === "already_running") setMessage(`${ticket.id} đang chạy.`);
      else if (status === "failed") setMessage(`${ticket.id} retry thất bại.`);
      else setMessage(`${ticket.id}: ${status ?? "đã gửi yêu cầu chạy"}`);
    } catch (error) { setMessage(error.message); }
  }
  async function remove() {
    if (!window.confirm(`Delete ticket ${ticket.id}?`)) return;
    try { await client.deleteTicket(projectId, ticket.id); onDeleted?.(ticket.id); setMessage("Deleted"); }
    catch (error) { setMessage(error.message); }
  }
  const resumable = ticket.checkpoint?.resumable === true;
  const disabled = ticket.status === "done" || ticket.status === "running";
  return <><article className="dashboard-ticket"><div><strong>{ticket.id}</strong><span className="priority">{ticket.priority}</span></div><p>{ticket.title}</p><small><span className={`ticket-status ticket-status-${ticket.status ?? "planned"}`}>{ticket.status ?? "planned"}</span> · {ticket.progress}%</small>{resumable && <small className="ticket-checkpoint">Có checkpoint dở ở turn {ticket.checkpoint.last_completed_turn ?? "?"}{ticket.checkpoint.last_tool ? ` (tool cuối: ${ticket.checkpoint.last_tool})` : ""}.</small>}<div className="ticket-actions"><button className="sprint-view-button small" onClick={view}>View</button>{resumable ? <button className="sprint-run-button small is-resume" onClick={() => run()} disabled={disabled}>Resume</button> : null}{resumable ? <button className="sprint-run-button small" onClick={() => run({ fresh: true })} disabled={disabled}>Run fresh</button> : <button className="sprint-run-button small" onClick={() => run()} disabled={disabled}>Run</button>}<button className="sprint-delete-button small" onClick={remove} disabled={disabled}>Delete</button></div>{message && <small>{message}</small>}</article>{viewOpen && <TicketModal ticket={detail ?? ticket} client={client} projectId={projectId} onRefreshed={(updatedTicket) => { setDetail(updatedTicket); onRefresh?.(); }} onClose={() => { setViewOpen(false); setDetail(null); }} />}</>;
}

function ticketVietnameseContext(ticket) {
  const context = ticket.context ?? ticket.vietnamese_context ?? ticket.original_vietnamese_context ?? ticket.content_vi;
  return context == null ? "" : typeof context === "string" ? context : JSON.stringify(context, null, 2);
}

function ticketEnglishContent(ticket) {
  const explicit = ticket.english_content ?? ticket.regenerated_english_content ?? ticket.generated_content ?? ticket.content_en;
  if (explicit) return String(explicit);
  return [
    ticket.title ? `Title: ${ticket.title}` : "",
    ticket.objective ? `Objective: ${ticket.objective}` : "",
    (ticket.acceptance_criteria ?? []).length ? `Acceptance criteria:\n${ticket.acceptance_criteria.map((item) => `- ${item}`).join("\n")}` : ""
  ].filter(Boolean).join("\n\n");
}

function TicketModal({ ticket, client, projectId, onRefreshed, onClose }) {
  const initialVietnameseContext = useMemo(() => ticketVietnameseContext(ticket), [ticket]);
  const [vietnameseContext, setVietnameseContext] = useState(initialVietnameseContext);
  const [englishContent, setEnglishContent] = useState(ticketEnglishContent(ticket));
  const [submitState, setSubmitState] = useState("idle");
  const [error, setError] = useState("");
  async function submitContentChange(event) {
    event.preventDefault();
    setSubmitState("submitting");
    setError("");
    const payload = { original_vietnamese_context: vietnameseContext, role: "sprint-leader", target_language: "en" };
    try {
      const response = client?.regenerateTicketEnglish
        ? await client.regenerateTicketEnglish(projectId, ticket.id, payload)
        : await fetch(`/forge/v1/tickets/${encodeURIComponent(ticket.id)}/regenerate-english?project=${encodeURIComponent(projectId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, project_id: projectId, ticket_id: ticket.id }) }).then(async (res) => { if (!res.ok) throw new Error(await res.text() || `Request failed (${res.status})`); return res.json(); });
      const updatedTicket = response?.ticket ?? response?.data?.ticket ?? (response?.id ? response : null);
      const regenerated = response?.english_content ?? response?.regenerated_english_content ?? response?.content ?? response?.ticket?.english_content ?? response?.ticket?.regenerated_english_content ?? response?.ticket?.content_en ?? response?.ticket?.generated_content ?? updatedTicket?.english_content ?? updatedTicket?.content_en ?? response?.ticket?.objective;
      if (!regenerated && !updatedTicket) throw new Error("Backend did not return regenerated English ticket content.");
      if (regenerated) setEnglishContent(String(regenerated));
      else if (updatedTicket) setEnglishContent(ticketEnglishContent(updatedTicket));
      // Ensure dashboard reflects persisted DB update without manual refresh.
      try { await onRefreshed?.(updatedTicket ?? response?.ticket ?? { ...ticket, english_content: String(regenerated) }); } catch {}
      setSubmitState("done");
    } catch (err) {
      setError(`Regeneration failed: ${err?.message ?? String(err)}`);
      setSubmitState("error");
    }
  }
  return <EntityDetailsModal title={ticket.id} modalClassName="ticket-language-modal" onClose={onClose}><div className="ticket-language-summary"><p className="sprint-objective">{ticket.title}</p><p><strong>Status:</strong> {ticket.status} · {ticket.progress}%</p></div>{englishContent && <section className="ticket-english-content ticket-regenerated-content" aria-live="polite"><h3>English content</h3><MessageContent text={englishContent} /></section>}<form className="ticket-content-change-panel" onSubmit={submitContentChange}><div className="ticket-language-header"><div><h3>Vietnamese context</h3><p>Edit the Vietnamese context, then regenerate the English ticket.</p></div></div><label>Vietnamese context<textarea value={vietnameseContext} onChange={(event) => setVietnameseContext(event.target.value)} rows={8} /></label><div className="ticket-regenerate-actions"><button className="sprint-run-button ticket-regenerate-button" type="submit" disabled={submitState === "submitting"}>{submitState === "submitting" ? "Regenerating…" : "Regenerate English"}</button></div>{error && <p className="dashboard-state error" role="alert">{error}</p>}</form></EntityDetailsModal>;
}

function EntityDetailsModal({ title, state, modalClassName = "", onClose, children }) {
  const content = <div className="sprint-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={`sprint-modal ${modalClassName}`.trim()} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button onClick={onClose} aria-label="Close details">&#215;</button></header><div className="sprint-modal-content">{state === "loading" && <p className="dashboard-state">Loading...</p>}{state && state !== "loading" && state !== "ready" && <p className="dashboard-state error">{state}</p>}{(!state || state === "ready") && children}</div></section></div>;
  return typeof document === "undefined" ? null : createPortal(content, document.body);
}

function WorkspaceSection({ title, items, empty }) {
  return <section className="workspace-section"><h3>{title}</h3>{items.length ? <div className="workspace-items">{items.map((item) => <div className="workspace-card" key={item.id}><strong>{item.title ?? item.id}</strong>{item.decision && <p>{item.decision}</p>}{item.objective && <p>{item.objective}</p>}{item.status && <span>{item.status}</span>}{item.tickets && <span>{item.tickets.length} ticket{item.tickets.length === 1 ? "" : "s"}</span>}</div>)}</div> : <p className="workspace-empty">{empty}</p>}</section>;
}

function formatRam(value) {
  if (value == null || value === "") return "-";
  if (typeof value === "number") {
    if (value > 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value > 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} MB`;
  }
  return String(value);
}

function formatCpu(value) {
  if (value == null || value === "") return "-";
  const str = String(value).trim();
  if (str.endsWith("%")) return str;
  const num = Number(str);
  if (!Number.isNaN(num)) return `${num}%`;
  return str;
}

function formatUptime(value) {
  if (value == null || value === "") return "-";
  if (typeof value === "number") {
    const s = Math.floor(value);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }
  return String(value);
}

function getAgentProcessData(agent) {
  if (!agent) return null;
  const proc = agent.process ?? agent.processStatus ?? agent.agentProcess ?? null;
  if (proc && typeof proc === "object") return proc;
  // direct fields on agent
  if (agent.pid != null || agent.ram != null || agent.memory != null || agent.cpu != null || agent.uptime != null) {
    return { pid: agent.pid, ram: agent.ram ?? agent.memory ?? agent.memoryUsage, cpu: agent.cpu ?? agent.cpuUsage ?? agent.cpuPercent, uptime: agent.uptime };
  }
  // try global process in SSR / Node context
  try {
    if (typeof process !== "undefined" && process.pid) {
      return { pid: process.pid, ram: process.memoryUsage ? `${Math.round(process.memoryUsage().rss / (1024 * 1024))} MB` : undefined, cpu: undefined, uptime: process.uptime ? Math.floor(process.uptime()) : undefined };
    }
  } catch {}
  return null;
}

export function AgentProcessStatus({ agent }) {
  const data = getAgentProcessData(agent);
  const pid = data?.pid ?? data?.PID ?? "-";
  const ramRaw = data?.ram ?? data?.RAM ?? data?.memory ?? data?.memoryUsage ?? data?.rss ?? "-";
  const cpuRaw = data?.cpu ?? data?.cpuUsage ?? data?.cpuPercent ?? data?.percentCpu ?? data?.["%CPU"] ?? "-";
  const uptimeRaw = data?.uptime ?? data?.Uptime ?? "-";
  const ram = ramRaw === "-" ? "-" : formatRam(ramRaw);
  const cpu = cpuRaw === "-" ? "-" : formatCpu(cpuRaw);
  const uptime = uptimeRaw === "-" ? "-" : formatUptime(uptimeRaw);
  return (
    <div className="agent-process-status" data-process-status={`${pid} | ${ram} | ${cpu} | ${uptime}`} style={{ marginLeft: "auto", textAlign: "right", fontSize: "0.78rem", opacity: 0.9, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flexShrink: 0, maxWidth: "55%", display: "flex", alignItems: "center", gap: "0.35rem" }} aria-label="Agent process status" title={`PID ${pid} | RAM ${ram} | %CPU ${cpu} | Uptime ${uptime}`}>
      <span>PID {pid}</span><span aria-hidden="true"> | </span><span>RAM {ram}</span><span aria-hidden="true"> | </span><span>%CPU {cpu}</span><span aria-hidden="true"> | </span><span>Uptime {uptime}</span>
    </div>
  );
}

export function PanelHeader({ agent, onSettings }) {
  return <header className="agent-header" style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}><div className={`agent-avatar ${agent.tone}`}>{agent.short}</div><div className="agent-heading"><h2>{agent.label}</h2><div className="agent-status"><span className="status-dot" /> {agent.status}</div></div><AgentProcessStatus agent={agent} /><button className="panel-menu" onClick={onSettings} title="Agent Settings" aria-label={`${agent.label} Agent Settings`}>&#9881;</button></header>;
}

export function Message({ message }) {
  const streaming = message.stream === true;
  const rowClass = `message-row natural-message ${message.from === "owner" ? "owner" : `agent${streaming ? " streaming" : ""}`}`;
  return <div id={`msg-${message.id}`} className={rowClass} data-message-id={message.id} data-correlation-id={message.correlation_id ?? ""} data-message-type={message.message_type ?? ""} data-role={message.from} data-timestamp={message.timestamp ?? ""}><MessageContent text={message.text} /><time dateTime={message.timestamp ?? ""} title={message.timestamp ?? ""}>{message.time}</time></div>;
}

export function MessageContent({ text }) {
  const parts = parseCodeBlocks(text);
  return <div className="message-content">{parts.map((part, index) => part.code
    ? <CodeBlock key={`code-${index}`} language={part.language} code={part.code} />
    : <TextWithInline key={`text-${index}`} text={part.text} />)}</div>;
}

function TextWithInline({ text }) {
  const value = String(text ?? "");
  if (!value) return null;
  const segments = [];
  const pattern = /`([^`]+)`/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(value))) {
    const start = match.index;
    if (start > last) segments.push({ text: value.slice(last, start) });
    segments.push({ inlineCode: match[1] });
    last = start + match[0].length;
  }
  if (last < value.length) segments.push({ text: value.slice(last) });
  if (segments.length === 0) return <p>{value}</p>;
  const hasInline = segments.some((s) => s.inlineCode);
  if (!hasInline) return <p>{value}</p>;
  return <p>{segments.map((seg, i) => seg.inlineCode ? <InlineCode key={i} code={seg.inlineCode} /> : <span key={i}>{seg.text}</span>)}</p>;
}

function InlineCode({ code }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
      else { const t = document.createElement("textarea"); t.value = code; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { setCopied(false); }
  }
  return <span className="inline-code-wrap"><code className="inline-code">{code}</code><button type="button" className="inline-copy" onClick={copy} aria-label="Copy command">{copied ? "Copied" : "Copy"}</button></span>;
}

function CodeBlock({ language, code }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
      else { const t = document.createElement("textarea"); t.value = code; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }
  return <div className="code-block"><div className="code-block-header"><span>{language || "code"}</span><button type="button" className={copied ? "is-copied" : ""} onClick={copy}>{copied ? "Copied" : "Copy"}</button></div><pre><code>{code}</code></pre></div>;
}

function parseCodeBlocks(text) {
  const value = String(text ?? "");
  const parts = [];
  const pattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ text: value.slice(cursor, start) });
    parts.push({ code: match[2].replace(/\n$/, ""), language: match[1].trim() });
    cursor = start + match[0].length;
  }
  if (parts.length === 0) {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        parts.push({ code: JSON.stringify(JSON.parse(trimmed), null, 2), language: "json" });
        return parts;
      } catch { /* treat malformed JSON as normal text */ }
    }
  }
  if (cursor < value.length || parts.length === 0) parts.push({ text: value.slice(cursor) });
  return parts;
}

function AgentPanel({ agent, messages, draft, onDraft, onSend, onActivate, active, expanded, onSettings }) {
  const conversationRef = useRef(null);
  const wasAtBottom = useRef(true);
  useEffect(() => {
    const element = conversationRef.current;
    if (!element) return;
    if (wasAtBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages]);
  return <article className={`agent-panel panel ${expanded ? "expanded" : ""} ${active ? "is-active" : ""}`} onClick={onActivate}>
    <PanelHeader agent={agent} onSettings={onSettings} />
    <div className="conversation" ref={conversationRef} onScroll={(event) => { const element = event.currentTarget; wasAtBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 56; }} role="log" aria-label={`${agent.label} messages`}>
      <div className="date-rule"><span>Today</span></div>
      {messages.map((message, index) => <Message key={message.id ?? `${message.time}-${index}`} message={message} />)}
      <div className="typing-line"><span className="typing-dots"><i /><i /><i /></span> Node is listening</div>
    </div>
    <form className="composer" onSubmit={(event) => { event.preventDefault(); onSend(); }}><input value={draft} onChange={(event) => onDraft(event.target.value)} placeholder={`Message ${agent.label}...`} aria-label={`Message ${agent.label}`} /><button type="submit" title="Send message" aria-label="Send message">&#8593;</button></form>
  </article>;
}
