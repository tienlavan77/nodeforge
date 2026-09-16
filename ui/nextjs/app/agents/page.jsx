"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { NodeForgeHeader } from "../../components/NodeForgeHeader.jsx";
import { AddAgentModal } from "../../components/AddAgentModal.jsx";

const API_URL = typeof window !== "undefined"
  ? `${window.location.protocol}//${window.location.hostname}:3100/forge/v1/agents`
  : "http://127.0.0.1:3100/forge/v1/agents";
const ROLE_LABELS = { coder: "Coder", reviewer: "Reviewer", sprint_leader: "Sprint leader", architecture_manager: "Architecture manager" };
const PROVIDER_MODELS = {
  claude: ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7", "claude-opus-5", "claude-opus-4-8[1m]", "claude-sonnet-4-5", "claude-sonnet-4-0", "claude-opus-4-5", "claude-haiku-4-3", "claude-3-5-sonnet-20241022"],
  anthropic: ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7", "claude-opus-5", "claude-opus-4-8[1m]", "claude-sonnet-4-5", "claude-sonnet-4-0", "claude-opus-4-5", "claude-haiku-4-3", "claude-3-5-sonnet-20241022"],
  openai: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.2", "gpt-5.6", "gpt-5.6-mini", "gpt-5.1"],
  codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.2", "gpt-5.6", "gpt-5.6-mini", "gpt-5.1"]
};

function normalizeAgents(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.agents)) return payload.agents;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function providerAsset(provider) {
  const key = String(provider ?? "").toLowerCase();
  if (key === "anthropic" || key === "claude") return { src: "/images/anthropic.svg", alt: "Anthropic logo" };
  if (key === "openai" || key === "codex") return { src: "/images/openai-light.svg", alt: key === "codex" ? "Codex logo" : "OpenAI logo" };
  return { src: "/images/openai-light.svg", alt: `${provider} logo` };
}

function displayValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ") || "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default function AgentsPage() {
  const [agents, setAgents] = useState([]);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [testState, setTestState] = useState("");
  const [testingAgent, setTestingAgent] = useState(null);
  const [connectionResult, setConnectionResult] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [editingAgent, setEditingAgent] = useState(null);
  const [form, setForm] = useState({ role: "architecture_manager", team: "Backend", agent_name: "", provider: "anthropic", model: "claude-sonnet-4-6", gateway_url: "https://gateway.example.test/agent", api_key: "", enabled: false });

  function updateField(event) {
    setForm((current) => {
      const next = { ...current, [event.target.name]: event.target.value };
      if (event.target.name === "provider") next.model = (PROVIDER_MODELS[next.provider] ?? PROVIDER_MODELS.openai)[0];
      return next;
    });
  }

  async function testConnection() {
    setTestState("Testing…");
    try { const testAgentId = editingAgent?.agent_id;
      const response = await fetch(`${API_URL}/${testAgentId}/test`, { method: "POST", cache: "no-store" }); const payload = await response.json(); if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`); setTestState(`Connected${payload.gateway_url ? `: ${payload.gateway_url}` : ""}`); } catch (error) { setTestState(error.message || "Connection failed."); }
  }

  function openEdit(agent) {
    setEditingAgent(agent);
    const provider = agent.provider ?? "anthropic";
    const role = agent.role ?? "coder";
    const availableModels = PROVIDER_MODELS[provider] ?? PROVIDER_MODELS.openai;
    const model = agent.model || availableModels[0];
    setForm({ role, team: agent.team ?? "Backend", agent_name: agent.agent_name ?? "", provider, model, gateway_url: agent.gateway_url ?? "https://gateway.example.test/agent", api_key: "", enabled: agent.enabled === true });
    setFormError("");
    setModalOpen(true);
  }


  async function testAgent(agent) {
    setTestingAgent(agent.agent_id);
    try {
      const response = await fetch(`${API_URL}/${agent.agent_id}/test`, { method: "POST", cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      setConnectionResult({ agent, ok: true, message: payload?.gateway_url ? `Connected to ${payload.gateway_url}` : "Agent connection succeeded." });
    } catch (error) {
      setConnectionResult({ agent, ok: false, message: error.message || "Connection failed." });
    } finally { setTestingAgent(null); }
  }

  function deleteAgent(agent) {
    setDeleteTarget(agent);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const response = await fetch(`${API_URL}/${deleteTarget.agent_id}`, { method: "DELETE", cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Agent could not be deleted.");
      setAgents((current) => current.filter((item) => item.agent_id !== deleteTarget.agent_id));
      setDeleteTarget(null);
    } catch (requestError) {
      setError(requestError.message || "Agent could not be deleted.");
    } finally {
      setDeleting(false);
    }
  }

  async function addAgent(event) {
    event.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      const formPayload = { ...form };
      const requestPayload = form.api_key ? formPayload : Object.fromEntries(Object.entries(formPayload).filter(([key]) => key !== "api_key"));
      const response = await fetch(editingAgent ? `${API_URL}/${editingAgent.agent_id}` : API_URL, { method: editingAgent ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestPayload) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || `Agents API returned HTTP ${response.status}.`);
      setAgents((current) => editingAgent ? current.map((item) => item.agent_id === editingAgent.agent_id ? payload : item) : [...current, payload]);
      setModalOpen(false);
      setEditingAgent(null);
      setForm({ role: "architecture_manager", team: "Backend", agent_name: "", provider: "anthropic", model: "claude-sonnet-4-6", gateway_url: "https://gateway.example.test/agent", api_key: "", enabled: false });
    } catch (requestError) {
      setFormError(requestError.message || "Agent could not be created.");
    } finally { setSaving(false); }
  }

  useEffect(() => {
    let active = true;
    fetch(API_URL)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Agents API returned HTTP ${response.status}.`);
        return response.json();
      })
      .then((payload) => {
        if (!active) return;
        setAgents(normalizeAgents(payload));
        setState("ready");
      })
      .catch((requestError) => {
        if (!active) return;
        setError(requestError.message || "Agents could not be loaded.");
        setState("error");
      });
    return () => { active = false; };
  }, []);

  return <div className="app-shell app-shell-control-room agent-profile-shell agents-directory-shell">
    <NodeForgeHeader title="NODEFORGE" subtitle="Supervisor Control Room" status={<><span className="live-dot" /> node online</>} actions={<Link className="history-button" href="/">Control room</Link>} />
    <main className="agents-directory" aria-label="Agents directory">
      <div className="agents-directory-heading"><div><p className="eyebrow">NODEFORGE RUNTIME</p><h1>Agents</h1></div><div className="agents-heading-actions"><span>{state === "ready" ? `${agents.length} agents` : state === "loading" ? "Loading" : "Unavailable"}</span></div></div>
      {state === "loading" && <p className="agents-directory-state">Loading agents from `/forge/v1/agents`…</p>}
      {state === "error" && <p className="agents-directory-state error">{error}</p>}
      {state === "ready" && agents.length === 0 && <p className="agents-directory-state">No agents returned by the API.</p>}
      {state === "ready" && <div className="agents-card-grid"><button className="agent-directory-card agent-add-card" type="button" onClick={() => { setEditingAgent(null); setForm({ role: "architecture_manager", team: "Backend", agent_name: "", provider: "anthropic", model: "claude-sonnet-4-6", gateway_url: "https://gateway.example.test/agent", api_key: "", enabled: false }); setTestState(""); setFormError(""); setModalOpen(true); }} aria-label="Add agent"><span>+</span><strong>Add agent</strong></button>{agents.map((agent, index) => {
        const id = agent.agent_id ?? agent.id ?? `agent-${index}`;
        const name = agent.agent_name ?? agent.name ?? agent.label ?? id;
        const capabilities = agent.capabilities ?? agent.tools ?? [];
        return <article className="agent-directory-card agent-card-editable" key={id} onClick={() => openEdit(agent)}>
          <div className="agent-card-header"><div className="agent-card-identity"><span className="agent-card-mark">{String(name).slice(0, 1).toUpperCase()}</span><div><strong>{name}</strong><small>{ROLE_LABELS[agent.role] ?? ROLE_LABELS[agent.agent_id] ?? displayValue(agent.role ?? id)}</small></div></div><div className="agent-header-actions"><button type="button" className={`agent-switch ${agent.enabled ? "is-on" : ""}`} onClick={(event) => { event.stopPropagation(); const enabled = !agent.enabled; setAgents((current) => current.map((item) => item.agent_id === id ? { ...item, enabled } : item)); fetch(`${API_URL}/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...agent, enabled }) }).then((response) => response.json()).then((updated) => setAgents((current) => current.map((item) => item.agent_id === id ? updated : item))).catch(() => setAgents((current) => current.map((item) => item.agent_id === id ? { ...item, enabled: agent.enabled } : item))); }} aria-label="Toggle agent"><i /></button></div></div>
          <div className="agent-card-provider"><span className={`provider-logo provider-${String(agent.provider).toLowerCase()}`}>{providerAsset(agent.provider) ? <img src={providerAsset(agent.provider).src} alt={providerAsset(agent.provider).alt} /> : <span className="provider-letter">{String(agent.provider ?? "?").slice(0, 1).toUpperCase()}</span>}</span><span>{displayValue(agent.model)}</span></div>
          <div className="agent-card-footer"><div className="agent-status-control"><select value={agent.status ?? "not_connected"} onClick={(event) => event.stopPropagation()} onChange={(event) => { event.stopPropagation(); fetch(`${API_URL}/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...agent, status: event.target.value, enabled: agent.enabled === true }) }).then((response) => response.json()).then((updated) => setAgents((current) => current.map((item) => item.agent_id === id ? updated : item))); }}><option value="ready">READY</option><option value="working">WORKING</option><option value="not_connected">NOT CONNECTED</option></select><div className="agent-card-actions"><button type="button" className="card-action-button" onClick={(event) => { event.stopPropagation(); testAgent(agent); }} disabled={testingAgent === id}>{testingAgent === id ? "Testing…" : "Test"}</button><button type="button" className="card-action-button danger" onClick={(event) => { event.stopPropagation(); deleteAgent(agent); }}>Delete</button></div></div></div>
        </article>;
      })}</div>}
    </main>
    {modalOpen && <AddAgentModal title={editingAgent ? "Edit agent" : "Add agent"} testState={testState} onTestConnection={testConnection} form={form} apiKeyMasked={editingAgent?.api_key_masked} modelOptions={[...new Set([form.model, ...(PROVIDER_MODELS[form.provider] ?? PROVIDER_MODELS.openai)])]} saving={saving} error={formError} onChange={updateField} onSubmit={addAgent} onClose={() => setModalOpen(false)} />}
    {connectionResult && <div className="connection-result-backdrop" role="presentation"><section className="connection-result-modal" role="dialog" aria-modal="true" aria-labelledby="connection-result-title"><div className="connection-result-icon">{connectionResult.ok ? "✓" : "!"}</div><p className="eyebrow">AGENT CONNECTION</p><h2 id="connection-result-title">{connectionResult.agent.agent_name ?? connectionResult.agent.agent_id}</h2><strong className={connectionResult.ok ? "connection-result-ok" : "connection-result-failed"}>{connectionResult.ok ? "Connected" : "Connection failed"}</strong><p>{connectionResult.message}</p><button className="history-button" type="button" onClick={() => setConnectionResult(null)}>Close</button></section></div>}
    {deleteTarget && <div className="connection-result-backdrop" role="presentation"><section className="connection-result-modal agent-delete-modal" role="dialog" aria-modal="true" aria-labelledby="delete-agent-title"><div className="connection-result-icon">!</div><p className="eyebrow">AGENT MANAGEMENT</p><h2 id="delete-agent-title">Delete agent</h2><p>Ban muon xoa agent nay khoi he thong?</p><strong>{deleteTarget.agent_name ?? deleteTarget.agent_id}</strong><div className="agent-modal-actions"><button className="history-button" type="button" onClick={() => setDeleteTarget(null)} disabled={deleting}>No</button><button className="history-button danger" type="button" onClick={confirmDelete} disabled={deleting}>{deleting ? "Deleting..." : "Yes, delete"}</button></div></section></div>}
  </div>;
}
