// NodeForge summary: Displays a human-readable Agent Profile with details, capabilities, status, and graceful empty/error states.
import Link from "next/link";

interface AgentProfile {
  agent_id?: string;
  name?: string;
  description?: string;
  role?: string;
  status?: string;
  enabled?: boolean;
  model?: string;
  provider?: string;
  created_at?: string;
  updated_at?: string;
  capabilities?: string[];
  [key: string]: unknown;
}

interface PageProps {
  params: Promise<{ agentId: string }>;
}

async function getAgentProfile(agentId: string): Promise<AgentProfile | null> {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? process.env.API_URL;
  if (!baseUrl) return null;

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/agents/${encodeURIComponent(agentId)}/profile`, {
    next: { revalidate: 30 },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Unable to load this agent profile.");
  return response.json();
}

function value(value: unknown): string {
  if (value === undefined || value === null || value === "") return "Not provided";
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  return String(value);
}

function formatDate(date: unknown): string {
  if (!date) return "Not provided";
  const parsed = new Date(String(date));
  return Number.isNaN(parsed.getTime()) ? String(date) : parsed.toLocaleString();
}

export default async function AgentProfilePage({ params }: PageProps) {
  const { agentId } = await params;
  let profile: AgentProfile | null = null;
  let error = false;

  try {
    profile = await getAgentProfile(agentId);
  } catch {
    error = true;
  }

  const displayName = profile?.name || profile?.agent_id || agentId;
  const capabilities = Array.isArray(profile?.capabilities) ? profile.capabilities : [];

  return (
    <main className="agent-profile-page">
      <div className="agent-profile-shell">
        <Link className="back-link" href="/agents">← Back to agents</Link>
        <header className="profile-header">
          <div>
            <p className="eyebrow">Agent profile</p>
            <h1>{displayName}</h1>
            <p className="agent-id">{agentId}</p>
          </div>
          {profile?.status && <span className={`status status-${profile.status.toLowerCase()}`}>{profile.status}</span>}
        </header>

        {error ? (
          <section className="empty-state" role="alert">
            <h2>Profile unavailable</h2>
            <p>We could not load this profile right now. Please try again later.</p>
          </section>
        ) : !profile ? (
          <section className="empty-state">
            <h2>No profile details yet</h2>
            <p>This agent does not have profile information available.</p>
          </section>
        ) : (
          <div className="profile-content">
            <section className="profile-card">
              <h2>About this agent</h2>
              <p className="description">{value(profile.description)}</p>
              <dl className="details-grid">
                <div><dt>Role</dt><dd>{value(profile.role)}</dd></div>
                <div><dt>Provider</dt><dd>{value(profile.provider)}</dd></div>
                <div><dt>Model</dt><dd>{value(profile.model)}</dd></div>
                <div><dt>Access</dt><dd>{profile.enabled === undefined ? value(profile.status) : value(profile.enabled)}</dd></div>
              </dl>
            </section>
            <section className="profile-card">
              <h2>Capabilities</h2>
              {capabilities.length ? <ul className="capabilities">{capabilities.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="muted">No capabilities listed.</p>}
            </section>
            <section className="profile-card metadata">
              <h2>Profile history</h2>
              <dl className="details-grid"><div><dt>Created</dt><dd>{formatDate(profile.created_at)}</dd></div><div><dt>Last updated</dt><dd>{formatDate(profile.updated_at)}</dd></div></dl>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
