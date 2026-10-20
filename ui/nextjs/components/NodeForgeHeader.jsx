// Top header with branding, project label and theme toggle.
"use client";

// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ThemeToggle } from "./ThemeToggle.jsx";

// Top navigation header with branding and actions.
export function NodeForgeHeader({ title, subtitle, status, project = "NODEFORGE", actions = null, className = "" }) {
  return (
    <header className={`topbar ${className}`.trim()}>
      <div className="brand">
        <div className="brand-mark">N</div>
        <div className="brand-copy">
          <div className="brand-name">{title}</div>
          <div className="brand-sub">{subtitle}</div>
        </div>
      </div>

      <div className="topbar-meta">
        {status && <span className="node-status">{status}</span>}
        {project && <div className="project-meta" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.2rem" }}>
          <span className="project-label">PROJECT <strong>{project}</strong></span>
        </div>}
        <div className="topbar-actions">
          {actions}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
