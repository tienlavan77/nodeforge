'use client';
// Configure agent connections and inspect persisted conversation history.

import { useCallback, useEffect, useState } from "react";

const PROJECT_ID = "PROJECT-NODEFORGE";
const AGENTS = [
  { id: "architecture-manager", label: "Architecture Manager" },
  { id: "sprint-leader", label: "Sprint Leader" },
  { id: "builder", label: "Builder" },
  { id: "reviewer", label: "Reviewer" }
];
const PROVIDER_OPTIONS = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "ollama", label: "Ollama" },
  { value: "custom", label: "Custom / OpenAI-compatible" }
];
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
  ],
  ollama: [
    { value: "gemma4:31b", label: "gemma4:31b" },
    { value: "gpt-oss:120b", label: "gpt-oss:120b" },
    { value: "gpt-oss:20b", label: "gpt-oss:20b" },
    { value: "nemotron-3-nano:30b", label: "nemotron-3-nano:30b" },
    { value: "nemotron-3-super", label: "nemotron-3-super" },
    { value: "nemotron-3-ultra", label: "nemotron-3-ultra" }
  ]
};

// Browse persisted conversation and audit records.
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
    } catch (error) {
      console.error("Unable to load conversation history", error);
      setState("error");
    }
  }, [agentId, client, conversationId, type]);
  useEffect(() => { setItems([]); load(); }, [load]);
  return <div className="history-overlay" role="dialog" aria-modal="true" aria-label="Conversation and Audit History"><section className="history-modal"><header><div><h2>Conversation &amp; Audit History</h2><p>Read-only Node audit trail</p></div><button onClick={onClose} aria-label="Close history">&#215;</button></header><div className="history-filters"><select value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">All agents</option>{AGENTS.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}</select><input value={conversationId} onChange={(event) => setConversationId(event.target.value)} placeholder="conversation_id" /><input value={type} onChange={(event) => setType(event.target.value)} placeholder="message/event type" /></div><div className="history-list">{state === "loading" && <p>Loading persisted history from Node…</p>}{state === "error" && <p className="error">Node could not load history.</p>}{state === "ready" && !items.length && <p>No persisted conversation or audit records match this filter.</p>}{items.map((item) => <article key={`${item.kind}-${item.id}`} className={`history-item ${item.kind}`}><div><strong>{item.kind}</strong><span>{item.type}</span></div><p>{JSON.stringify(item.content)}</p><small>{item.timestamp} · {item.sender} → {item.receiver}{item.conversation_id ? ` · ${item.conversation_id}` : ""}{item.correlation_id ? ` · ${item.correlation_id}` : ""}</small></article>)}{nextCursor && <button className="history-more" onClick={() => load(nextCursor)}>Load more</button>}</div></section></div>;
}

// Edit provider credentials and connectivity for an agent.
export function AgentSettingsOverlay({ client, agent, onClose }) {
  const [profile, setProfile] = useState(null); const [url, setUrl] = useState(""); const [key, setKey] = useState(""); const [provider, setProvider] = useState("codex"); const [model, setModel] = useState(""); const [enabled, setEnabled] = useState(false); const [message, setMessage] = useState("");
  const models = MODEL_CATALOG[provider] ?? [];
  useEffect(() => { client.getAgentSettings().then((items) => { const item = items.find(({ agent_id: id }) => id === agent.id); if (item) { setProfile(item); setUrl(item.gateway_url ?? ""); setEnabled(Boolean(item.enabled)); setProvider(item.provider ?? "codex"); setModel(item.model ?? ""); } }).catch((error) => setMessage(`Error: ${error.message}`)); }, [agent.id, client]);
  function changeProvider(value) {
    const nextModels = MODEL_CATALOG[value] ?? [];
    setProvider(value);
    setModel(nextModels.some((item) => item.value === model) ? model : nextModels[0]?.value ?? "");
    if (value === "ollama") setUrl("https://ollama.com/v1/chat/completions");
  }
  async function save() { try { const item = await client.saveAgentSettings(agent.id, { agent_name: profile?.agent_name ?? agent.label, gateway_url: url, provider, model: models.length ? model : "", enabled, ...(key ? { api_key: key } : {}) }); setProfile(item); setKey(""); setMessage("Saved. API key remains masked in Node."); } catch (error) { setMessage(`Error: ${error.message}`); } }
  async function testConnection() { try { const result = await client.testAgentConnection(agent.id); setMessage(`Connected: ${result.status}`); } catch (error) { setMessage(`Failed: ${error.message}`); } }
  return <div className="settings-overlay" role="dialog" aria-modal="true"><section className="settings-modal"><header><h2>{agent.label} Settings</h2><button onClick={onClose} aria-label="Close Agent Settings">&#215;</button></header><label>Provider<select value={provider} onChange={(event) => changeProvider(event.target.value)} aria-label="Provider">{PROVIDER_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}</select></label><label>Model<select value={model} onChange={(event) => setModel(event.target.value)} aria-label="Model" disabled={!models.length}><option value="">{models.length ? "Select model" : "No model catalog for this provider"}</option>{models.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}</select></label><label>Gateway URL<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." /></label><label>API Key<input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder="********" autoComplete="new-password" /></label><label className="settings-check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enabled</label><div className="settings-actions"><button onClick={save}>Save Profile</button><button onClick={testConnection}>Test Connection</button></div>{profile?.api_key_masked && <small className="settings-mask">API key masked: {profile.api_key_masked}</small>}{message && <p aria-live="polite">{message}</p>}</section></div>;
}
