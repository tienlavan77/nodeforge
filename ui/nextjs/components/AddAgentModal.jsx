"use client";

import { useState } from "react";
import { Dialog } from "./Dialog";

const DIALOG_TITLE_ID = "add-agent-title";
const DIALOG_VARIANT = "modal";
const CLOSE_ON_OUTSIDE_CLICK = true;

function SelectMenu({ label, name, value, options, openName, setOpenName, onChange }) {
  const open = openName === name;
  const selected = options.find((option) => option.value === value) ?? options[0];
  return <label className={`agent-select-field ${open ? "is-open" : ""}`}>{label}
    <span className="agent-select-wrap">
      <button className="agent-select-trigger" type="button" aria-haspopup="listbox" aria-expanded={open} onClick={(event) => { event.stopPropagation(); setOpenName(open ? null : name); }}>{selected?.label ?? value}<span className="agent-select-arrow">⌄</span></button>
      {open && <span className="agent-select-menu" role="listbox">{options.map((option) => <button className={`agent-select-option ${option.value === value ? "is-selected" : ""}`} type="button" role="option" aria-selected={option.value === value} key={option.value} onClick={(event) => { event.stopPropagation(); onChange({ target: { name, value: option.value } }); setOpenName(null); }}>{option.label}</button>)}</span>}
    </span>
  </label>;
}

// Render the agent form through the shared accessible dialog owner.
export function AddAgentModal({ title = "Add agent", form, modelOptions, apiKeyMasked, saving, error, testState, onTestConnection, onChange, onSubmit, onClose }) {
  // Team selector rendered below Role with options: Backend, Frontend, Security
  const [openName, setOpenName] = useState(null);
  const roles = [{ value: "architecture_manager", label: "Architecture Manager" }, { value: "system_engineer", label: "System Engineer" }, { value: "sprint_leader", label: "Sprint Leader" }, { value: "coder", label: "Coder" }, { value: "reviewer", label: "Reviewer" }, { value: "linguist", label: "Linguist" }];
  const teams = [{ value: "Backend", label: "Backend" }, { value: "Frontend", label: "Frontend" }, { value: "Security", label: "Security" }];
  const providers = [{ value: "anthropic", label: "Anthropic" }, { value: "claude", label: "Claude" }, { value: "openai", label: "OpenAI" }, { value: "codex", label: "Codex" }, { value: "xai", label: "xAI" }, { value: "alibaba", label: "Alibaba" }, { value: "zhipu", label: "Zhipu" }, { value: "deepseek", label: "DeepSeek" }, { value: "ollama", label: "Ollama" }];
  const models = modelOptions ?? [];
  return <Dialog open onClose={onClose} labelledBy={DIALOG_TITLE_ID} label={title} describedBy={error ? "agent-form-error" : undefined} variant={DIALOG_VARIANT} closeOnOutsideClick={CLOSE_ON_OUTSIDE_CLICK} className="agent-modal-backdrop" panelStyle={{ width: "min(520px, calc(100vw - 40px))", maxHeight: "min(82vh, calc(100vh - 40px))", borderRadius: 0, background: "var(--app-panel)" }}>
    <div className="agent-modal" style={{ width: "100%", maxHeight: "none", marginTop: 0, border: 0, boxShadow: "none" }} onClick={() => setOpenName(null)}>
      <header><div><p className="eyebrow">NODEFORGE RUNTIME</p><h2 id="add-agent-title">{title}</h2></div><button className="agent-modal-close" type="button" onClick={onClose} aria-label="Close">×</button></header>
      <form onSubmit={onSubmit}>
        <label>Agent name<input name="agent_name" value={form.agent_name} onChange={onChange} required placeholder="Architecture Manager" /></label>
        <SelectMenu label="Role" name="role" value={form.role} options={roles} openName={openName} setOpenName={setOpenName} onChange={onChange} />
        <SelectMenu label="Team" name="team" value={form.team || "Backend"} options={teams} openName={openName} setOpenName={setOpenName} onChange={onChange} />
        <SelectMenu label="Provider" name="provider" value={form.provider} options={providers} openName={openName} setOpenName={setOpenName} onChange={onChange} />
        <SelectMenu label="Model" name="model" value={form.model} options={models} openName={openName} setOpenName={setOpenName} onChange={onChange} />
        <label>Gateway URL<input name="gateway_url" value={form.gateway_url} onChange={onChange} required placeholder="https://..." /></label>
        <label>API key<input name="api_key" type="password" value={form.api_key} onChange={onChange} placeholder={apiKeyMasked || "Optional"} /></label>
        {error && <p id="agent-form-error" className="agent-form-error">{error}</p>}
        {testState && <p className="agent-test-state">{testState}</p>}
        <div className="agent-modal-actions"><button className="history-button" type="button" onClick={onClose}>Cancel</button><button className="history-button agent-submit-button" type="submit" disabled={saving}>{saving ? "Saving…" : title === "Edit agent" ? "Save" : "Add agent"}</button></div>
      </form>
    </div>
  </Dialog>;
}
