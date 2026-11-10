// Normalize Coding workspace agent activity details, deterministic color tones, and project isolation.
import { codingAgentPanelKey, codingAgentProfile } from "./coding-agent-panel-registry.js";
import { agentDisplayName, displayMessageTime } from "./home-page-watcher-events.js";

const AGENT_TONES = ["#62d39b", "#6ab0f3", "#d8b66a", "#c792ea", "#f07178", "#89ddff", "#ffcb6b", "#a3be8c"];

// Business purpose: Ensures agent display names in the Coding workspace monitor remain readable against the dark monitor surface.
// Technical description: Parses 3-digit or 6-digit hex color strings, computes relative sRGB luminance, and verifies at least a 4.5:1 WCAG contrast ratio against the dark panel background.
function isAccessibleMonitorColor(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(trimmed)?.[1];
  if (!hex) return false;
  const full = hex.length === 3 ? hex.split("").map((char) => char + char).join("") : hex;
  const channels = [0, 2, 4].map((offset) => {
    const srgb = Number.parseInt(full.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return (luminance + 0.05) / (0.014 + 0.05) >= 4.5;
}

// Assign a deterministic, high-contrast color tone to each Coding agent identity, falling back when explicitColor is unreadable.
export function resolveCodingAgentTone(agentId, explicitColor) {
  if (isAccessibleMonitorColor(explicitColor)) return explicitColor.trim();
  const key = String(agentId ?? "agent").trim() || "agent";
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  return AGENT_TONES[hash % AGENT_TONES.length];
}

// Normalize and filter Coding agent activity events for the active project with resolved agent names, details, and stable tones.
export function resolveCodingAgentActivities(agentActivities = [], agentDirectory = [], projectId = null) {
  const list = Array.isArray(agentActivities) ? agentActivities : [];
  const agents = Array.isArray(agentDirectory) ? agentDirectory : [];
  return list.filter((event) => {
    if (!event || (event.event_type && event.event_type !== "agent.activity")) return false;
    const payload = event.payload ?? {};
    if (payload.sdk_event?.type === "conversation_turn") return false;
    const agentId = payload.agent_id ?? event.agent_id ?? payload.agentId;
    if (projectId && event.project_id && event.project_id !== projectId) return false;
    if (projectId && payload.project_id && payload.project_id !== projectId) return false;
    if (event.agent_id !== undefined && payload.agent_id !== undefined && event.agent_id !== payload.agent_id) return false;
    if (payload.agentId !== undefined && payload.agent_id !== undefined && payload.agentId !== payload.agent_id) return false;
    if (projectId && agentId && !codingAgentPanelKey(projectId, agentId)) return false;
    if (agents.length > 0 && projectId && agentId && !codingAgentProfile(agents, agentId, projectId)) return false;
    return Boolean(agentId || event.agent_name || payload.agent_name || payload.summary || event.summary || payload.tool_name || event.tool_name);
  }).map((event, index) => {
    const payload = event.payload ?? {};
    const agentId = payload.agent_id ?? event.agent_id ?? payload.agentId;
    const baseAgentId = typeof agentId === "string" && agentId.includes(":sub:") ? agentId.split(":sub:")[0] : agentId;
    const subagentSuffix = typeof agentId === "string" && agentId.includes(":sub:") ? agentId.split(":sub:").at(-1) : "";
    const profile = (projectId && agentId ? codingAgentProfile(agents, agentId, projectId) : null) ?? agents.find((agent) => (agent?.agent_id ?? agent?.id) === agentId || (agent?.agent_id ?? agent?.id) === baseAgentId) ?? null;
    const baseName = profile?.agent_name ?? profile?.name ?? profile?.label ?? event.agent_name ?? payload.agent_name ?? agentDisplayName(baseAgentId, agents);
    const resolvedName = subagentSuffix ? `${baseName} [sub:${subagentSuffix}]` : baseName;
    const identityKey = String(baseAgentId ?? profile?.role ?? baseName ?? "agent");
    const tone = resolveCodingAgentTone(identityKey, profile?.color ?? profile?.agent_color);
    const activityType = String(payload.activity_type ?? event.activity_type ?? "activity").replaceAll("_", " ");
    const status = String(payload.status ?? event.status ?? "working");
    const time = displayMessageTime(event.timestamp ?? payload.timestamp);
    const toolName = payload.tool_name ?? event.tool_name ?? "";
    const summary = payload.summary ?? event.summary ?? (toolName || activityType);
    const detail = summary && toolName && !String(summary).includes(toolName) ? `${summary} (${toolName})` : (summary || toolName || activityType);
    const role = profile?.role ?? event.agent_role ?? payload.agent_role ?? "";
    return { key: event.event_id ?? event.id ?? `${agentId ?? "agent"}-${event.timestamp ?? index}-${index}`, agentId: agentId ?? "agent", agentName: resolvedName, role, activityType, status, time, toolName, summary, detail, tone };
  });
}
