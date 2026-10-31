// Lets the owner switch the selected System Engineer between Forge and native SDK tools.
"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { GitStatusIndicator } from "./git-status-indicator.jsx";
import { resolveConversationProjectName } from "./conversation-project-git.jsx";
import { SegmentedControl } from "./segmented-control.jsx";
import { getModelOptions, useModelCatalog } from "../lib/model-catalog.js";
import { getProjectDirectory, subscribeProjectDirectory } from "../lib/project-directory-client.js";
import { getProjectSelection, subscribeProjectSelection } from "../lib/project-selection.js";

const PROVIDERS = [["openai", "OpenAI"], ["codex", "Codex"], ["anthropic", "Anthropic"], ["claude", "Claude"], ["ollama", "Ollama"], ["xai", "xAI"], ["alibaba", "Alibaba"], ["zhipu", "Zhipu"], ["deepseek", "DeepSeek"]];
const EFFORTS = [["low", "Low"], ["medium", "Medium"], ["high", "High"]];
const TOOL_MODES = [["forge", "Forge"], ["builtin", "Built-in"]];
const BUILTIN_PROVIDERS = new Set(["codex", "claude", "anthropic"]);
const EMPTY_CATALOG = { projects: [] };

// Saves tool mode on the agent profile while keeping active SDK sessions unchanged.
export function SystemToolMode({ agent, client, projectId, onSaved, busy = false }) {
  const catalog = useModelCatalog();
  const directory = useSyncExternalStore(subscribeProjectDirectory, getProjectDirectory, () => EMPTY_CATALOG);
  const selection = useSyncExternalStore(subscribeProjectSelection, getProjectSelection, () => EMPTY_CATALOG);
  const projectName = resolveConversationProjectName(projectId, directory?.projects, selection?.projects);
  const [open, setOpen] = useState(false); const [saving, setSaving] = useState(false); const [error, setError] = useState(""); const [draft, setDraft] = useState(null);
  const agentId = agent?.agent_id ?? agent?.id;
  const models = useMemo(() => getModelOptions(catalog, draft?.provider), [catalog, draft?.provider]);
  const builtinAllowed = agent?.role === "system_engineer" && BUILTIN_PROVIDERS.has(draft?.provider);
  useEffect(() => { if (!agent) { setDraft(null); return; } const provider = agent.provider ?? "codex"; const options = getModelOptions(catalog, provider); const configuredEffort = agent.reasoning?.effort ?? agent.reasoning_effort; setDraft({ provider, model: options.some((item) => item.value === agent.model) ? agent.model : (options[0]?.value ?? ""), effort: EFFORTS.some(([value]) => value === configuredEffort) ? configuredEffort : "medium", tool_mode: agent.tool_mode ?? "forge" }); setError(""); }, [agentId, agent?.provider, agent?.model, agent?.reasoning?.effort, agent?.reasoning_effort, agent?.tool_mode]);
  const projectGit = client && projectId ? <div className="home-plan-approval-project"><span className="home-plan-project-icon" aria-label="Project"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3.5 6.5h6l1.7 2H20.5v9.7a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8V6.5Z" /></svg></span><strong className="claude-chat-header-project-name" title={projectName}>{projectName}</strong><span className="home-plan-git-icon" aria-hidden="true">⌘</span><GitStatusIndicator client={client} projectId={projectId} /></div> : null;
  if (!agent || !draft) return <div className="claude-composer-tool-mode">{projectGit}</div>;
  const current = { ...draft, tool_mode: builtinAllowed ? draft.tool_mode : "forge" };
  const saved = { provider: agent.provider ?? "codex", model: agent.model ?? "", effort: agent.reasoning?.effort ?? agent.reasoning_effort ?? "medium", tool_mode: agent.tool_mode ?? "forge" };
  const changed = JSON.stringify(current) !== JSON.stringify(saved);
  // Keeps model and tool choices valid after a provider change.
  function update(name, value) { setDraft((old) => { const next = { ...old, [name]: value }; if (name === "provider") { const options = getModelOptions(catalog, value); next.model = options.some((item) => item.value === old.model) ? old.model : (options[0]?.value ?? ""); if (agent?.role !== "system_engineer" || !BUILTIN_PROVIDERS.has(value)) next.tool_mode = "forge"; } return next; }); }
  // Persists all selectors as one agent profile update.
  async function save() { if (!changed || saving || busy) return; setSaving(true); setError(""); try { const result = await client.saveAgentSettings(agentId, { provider: current.provider, model: current.model, reasoning: { effort: current.effort }, tool_mode: current.tool_mode }); onSaved?.(result); setOpen(false); } catch (failure) { setError(failure.message ?? "Could not save agent settings."); } finally { setSaving(false); } }
  return <div className="claude-composer-tool-mode">{projectGit}<div className="composer-agent-settings"><button type="button" className="composer-agent-settings-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)} disabled={saving || busy}>⚙ Settings</button>{open && <div className="composer-agent-settings-menu" role="dialog" aria-label="Agent settings"><label>Provider<select value={draft.provider} onChange={(event) => update("provider", event.target.value)}>{PROVIDERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Model<select value={draft.model} onChange={(event) => update("model", event.target.value)} disabled={!models.length}><option value="">{models.length ? "Select model" : "No models"}</option>{models.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><SegmentedControl name="effort" label="Effort" value={draft.effort} options={EFFORTS.map(([value, choiceLabel]) => ({ value, label: choiceLabel }))} onChange={(value) => update("effort", value)} disabled={saving || busy} /><SegmentedControl name="tool_mode" label="Tools" value={current.tool_mode} options={TOOL_MODES.map(([value, choiceLabel]) => ({ value, label: choiceLabel, disabled: value === "builtin" && !builtinAllowed }))} onChange={(value) => update("tool_mode", value)} disabled={saving || busy} /><button type="button" className="composer-agent-settings-save" onClick={save} disabled={!changed || saving || busy}>{saving ? "Saving…" : "Save"}</button>{error && <small role="alert">{error}</small>}</div>}</div></div>;
}
