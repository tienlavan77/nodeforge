// Let owners choose or add an admitted project before opening an Architecture workspace.
"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { Dialog } from "./Dialog.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ProjectCard } from "./project-card.jsx";
import { addProject, clearProjectSelection, getProjectSelection, refreshProjects, subscribeProjectSelection } from "../lib/project-selection.js";

const initialSelection = { projects: [], loaded: false, error: null };

// Render project cards and recoverable directory errors without mounting project-bound chat clients.
export function ProjectDirectory() {
  const selection = useSyncExternalStore(subscribeProjectSelection, getProjectSelection, () => initialSelection);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [root, setRoot] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  // Refresh the actual runtime directory while keeping a failed request visible and retryable.
  async function load() {
    setLoading(true); setError("");
    try { await refreshProjects({ selectInitial: false }); }
    catch (failure) { setError(failure.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { clearProjectSelection(); void load(); }, []);

  // Add a root through the existing governed lifecycle operation, then show its project card.
  async function submit(event) {
    event.preventDefault(); setSaving(true); setFormError("");
    try { await addProject(root.trim()); setAdding(false); setRoot(""); setError(""); }
    catch (failure) { setFormError(failure.message); }
    finally { setSaving(false); }
  }

  // Keep the directory mounted while loading, retrying, or disconnected. A loaded empty
  // directory is still a real page, and a failed refresh must not replace it with a notice.
  const loadingStatus = loading && !selection.loaded;
  const statusMessage = error || (loadingStatus ? "Loading projects…" : "");

  return <div className="app-shell app-shell-control-room projects-directory-shell">
    <p role={error ? "alert" : "status"} aria-live="polite" className="project-workspace-stale" hidden={!statusMessage}>
      {error ? <>Connection to the Node API was lost. Showing the last known project list; some information may be out of date. <button className="history-button" type="button" onClick={load} disabled={loading}>{loading ? "Connecting…" : "Try again"}</button></> : statusMessage}
    </p>
    <main className="projects-directory" aria-label="Projects directory">
      <section className="projects-stage" aria-labelledby="projects-brand-title">
        <div className="projects-hero">
          <div className="projects-brand-badge"><span className="projects-brand-mark" aria-hidden="true">N</span><span className="projects-brand-kicker"><i aria-hidden="true" />AI ENGINEERING CONTROL ROOM</span></div>
          <h1 id="projects-brand-title">NodeForge</h1>
          <p className="projects-hero-lead">Không gian phát triển phần mềm cùng đội ngũ AI — chọn một dự án để bắt đầu điều phối kiến trúc, sprint và mã nguồn.</p>
        </div>
        <div className="projects-workspace-panel" aria-label="Project workspaces">
          <div className="projects-section-bar">
            <span className="projects-section-label">ACTIVE WORKSPACES</span>
            <span className="projects-section-count">{`${selection.projects.length} project${selection.projects.length === 1 ? "" : "s"}`}</span>
          </div>
          {!loading && !error && !selection.projects.length && <p className="agents-directory-state">No projects yet. Add a project to get started.</p>}
          <div className="agents-card-grid projects-card-grid">
            {selection.projects.map((project) => <ProjectCard key={project.project_id} project={project} />)}
            <button className="agent-directory-card agent-add-card project-add-card" type="button" aria-label="Add project" onClick={() => { setFormError(""); setAdding(true); }}><span aria-hidden="true">＋</span><strong>Add project</strong><small>Open another workspace</small></button>
          </div>
        </div>
      </section>
      <section className="projects-introduction" aria-labelledby="projects-introduction-title" lang="vi">
        <div className="projects-introduction-header">
          <span className="projects-intro-eyebrow">QUY TRÌNH KHÉP KÍN</span>
          <h2 id="projects-introduction-title">Từ ý tưởng đến sản phẩm, trong một không gian.</h2>
          <p>NodeForge kết nối trao đổi, lập kế hoạch và triển khai mã nguồn theo từng dự án. Bạn định hướng và phê duyệt; các agent phối hợp thực hiện với tiến độ và kết quả kiểm tra rõ ràng.</p>
        </div>
        <div className="projects-features">
          <article className="projects-feature-card"><span className="projects-feature-step" aria-hidden="true">01</span><h3>Làm rõ ý tưởng</h3><p>Trao đổi với Architecture Manager để xác định phạm vi và xây dựng kế hoạch có thể xem xét trước khi triển khai.</p></article>
          <article className="projects-feature-card"><span className="projects-feature-step" aria-hidden="true">02</span><h3>Phối hợp thực hiện</h3><p>Tổ chức công việc theo sprint và ticket, với các agent đảm nhiệm lập kế hoạch, viết mã và review.</p></article>
          <article className="projects-feature-card"><span className="projects-feature-step" aria-hidden="true">03</span><h3>Theo dõi &amp; kiểm chứng</h3><p>Theo dõi hoạt động của agent, thay đổi Git và kết quả kiểm tra trong không gian riêng của mỗi project.</p></article>
        </div>
      </section>
    </main>
    <Dialog open={adding} onClose={() => { if (!saving) setAdding(false); }} labelledBy="project-add-title" panelStyle={{ width: "min(520px, calc(100vw - 32px))", borderRadius: 0, background: "var(--app-panel)" }}>
      <div className="agent-modal project-add-modal">
        <header><div><p className="eyebrow">WORKSPACE</p><h2 id="project-add-title">Add project</h2></div><button className="agent-modal-close" type="button" aria-label="Close" onClick={() => setAdding(false)} disabled={saving}>×</button></header>
        <form onSubmit={submit}>
          <label>Project folder<input required placeholder="/home/data/sites/my-project" value={root} onChange={(event) => setRoot(event.target.value)} /></label>
          {formError && <p className="agent-form-error" role="alert">{formError}</p>}
          <div className="agent-modal-actions"><button className="history-button" type="button" onClick={() => setAdding(false)} disabled={saving}>Cancel</button><button className="history-button agent-submit-button" type="submit" disabled={saving}>{saving ? "Adding…" : "Add project"}</button></div>
        </form>
      </div>
    </Dialog>
  </div>;
}
