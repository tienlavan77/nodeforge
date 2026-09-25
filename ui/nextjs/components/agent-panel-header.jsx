'use client';
// Show agent identity and live process metrics in workspace panel headers.

// Formats a RAM value into a readable size string.
function formatRam(value) {
  if (value == null || value === "") return "-";
  if (typeof value === "number") {
    if (value > 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value > 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} MB`;
  }
  return String(value);
}

// Formats a CPU value into a percentage string.
function formatCpu(value) {
  if (value == null || value === "") return "-";
  const str = String(value).trim();
  if (str.endsWith("%")) return str;
  const num = Number(str);
  if (!Number.isNaN(num)) return `${num}%`;
  return str;
}

// Formats an uptime value into a duration string.
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

// Resolves process status data from an agent object.
function getAgentProcessData(agent) {
  if (!agent) return null;
  const proc = agent.process ?? agent.processStatus ?? agent.agentProcess ?? null;
  if (proc && typeof proc === "object") return proc;
  if (agent.pid != null || agent.ram != null || agent.memory != null || agent.cpu != null || agent.uptime != null) {
    return { pid: agent.pid, ram: agent.ram ?? agent.memory ?? agent.memoryUsage, cpu: agent.cpu ?? agent.cpuUsage ?? agent.cpuPercent, uptime: agent.uptime };
  }
  try {
    if (typeof process !== "undefined" && process.pid) {
      return { pid: process.pid, ram: process.memoryUsage ? `${Math.round(process.memoryUsage().rss / (1024 * 1024))} MB` : undefined, cpu: undefined, uptime: process.uptime ? Math.floor(process.uptime()) : undefined };
    }
  } catch (error) {
    console.error("Unable to read process metrics", error);
  }
  return null;
}

// Displays agent process metrics in the header.
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

// Header for an agent panel with avatar and settings.
export function PanelHeader({ agent, onSettings }) {
  return <header className="agent-header" style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}><div className={`agent-avatar ${agent.tone}`}>{agent.short}</div><div className="agent-heading"><h2>{agent.agent_name ?? agent.label}</h2><div className="agent-status"><span className="status-dot" /> {agent.status}</div></div><AgentProcessStatus agent={agent} /><button className="panel-menu" onClick={onSettings} title="Agent Settings" aria-label={`${agent.agent_name ?? agent.label} Agent Settings`}>&#9881;</button></header>;
}
