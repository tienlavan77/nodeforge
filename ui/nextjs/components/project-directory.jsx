// Let owners choose or add an admitted project before opening an Architecture workspace.
"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { Dialog } from "./Dialog.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ProjectCard } from "./project-card.jsx";
import { getProjectSelection, refreshProjects, subscribeProjectSelection } from "../lib/project-selection.js";
import { getProjectDirectory, refreshProjectDirectory, subscribeProjectDirectory } from "../lib/project-directory-client.js";
import { getLifecycleSnapshot, subscribeLifecycle, submitProjectOperation, reloadOperation } from "../lib/project-lifecycle-client.js";
import { ProjectOperationStatus } from "./project-operation-status.jsx";

const initialSelection = { projects: [], loaded: false, error: null };

// Render project cards and recoverable directory errors without mounting project-bound chat clients.
export function ProjectDirectory() {
  const selection = useSyncExternalStore(subscribeProjectSelection, getProjectSelection, () => initialSelection);
  const directory = useSyncExternalStore(subscribeProjectDirectory, getProjectDirectory, () => initialSelection);
  const lifecycle = useSyncExternalStore(subscribeLifecycle, getLifecycleSnapshot, getLifecycleSnapshot);
  const [kind, setKind] = useState("add");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [root, setRoot] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  // Associate each tracked receipt with directory attempts without equating their independent counters.
  const directoryAttempts = useRef(new Map());

  // Refresh the actual runtime directory while keeping a failed request visible and retryable.
  async function load() {
    setLoading(true); setError("");
    const results = await Promise.allSettled([refreshProjectDirectory(), refreshProjects({ selectInitial: false })]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) setError(failure.reason.message);
    setLoading(false);
    return !failure;
  }
  useEffect(() => {
    let active = true;
    let timer;
    // Poll only while the directory is mounted; observation never sends cancellation or retries.
    async function observe() {
      await load();
      if (!active) return;
      const current = getLifecycleSnapshot();
      await Promise.allSettled(Object.keys(current.pending).filter((key) =>
        !current.operations[key] || ["pending", "running"].includes(current.operations[key].status)
      ).map((key) => reloadOperation(key)));
      if (active) timer = setTimeout(observe, 1500);
    }
    void observe();
    return () => { active = false; clearTimeout(timer); };
  }, []);

  // Add a root through the existing governed lifecycle operation, then show its project card.
  async function submit(event) {
    event.preventDefault(); setSaving(true); setFormError("");
    if (!root.trim().startsWith("/")) { setFormError("Enter an absolute server path."); event.currentTarget.elements.namedItem("root").focus(); setSaving(false); return; }
    try {
      await submitProjectOperation(kind, root.trim());
      setAdding(false); setRoot("");
      const fresh = await load();
      setNotice(fresh ? "Operation accepted. Tracking backend status." : "Operation accepted; directory data has not reloaded. Reload directory.");
    }
    catch (failure) {
      setFormError(failure.message);
      if (failure.requestKey) { setAdding(false); setNotice("Outcome unknown. Reload status with the original request key."); }
    }
    finally { setSaving(false); }
  }

  // Keep the directory mounted while loading, retrying, or disconnected. A loaded empty
  // directory is still a real page, and a failed refresh must not replace it with a notice.
  const loadingStatus = loading && !directory.loaded;
  const operations = Object.values(lifecycle.operations);
  // Resolve tracked operations by backend identity or submitted root without inventing directory membership.
  function operationFor(project) {
    const operation = operations.filter((entry) => entry.project_id === project.project_id || entry.root === project.root).at(-1);
    if (!operation) return undefined;
    const previous = directoryAttempts.current.get(operation.request_key);
    if (!previous || operation.attempt > previous.attempt) {
      directoryAttempts.current.set(operation.request_key, { attempt: operation.attempt, directoryAttempt: project.operation?.attempt_id,
        awaitingAttempt: operation.status === "running" && project.operation?.status !== "running" });
    }
    const associated = directoryAttempts.current.get(operation.request_key);
    if (associated.directoryAttempt !== project.operation?.attempt_id) {
      if (!associated.awaitingAttempt) return undefined;
      associated.directoryAttempt = project.operation?.attempt_id;
      associated.awaitingAttempt = false;
    }
    if (["failed", "succeeded"].includes(operation.status) && project.operation?.status !== operation.status) return undefined;
    return operation;
  }
  // Recover a membership-only startup failure through the backend's documented explicit Add path.
  async function retryAdd(path) {
    try { await submitProjectOperation("add", path); await load(); }
    catch (failure) { setError(failure.message); }
  }
  const statusMessage = error || (loadingStatus ? "Loading projects…" : "");

  return <div className="app-shell app-shell-control-room projects-directory-shell">
    <p role={error ? "alert" : "status"} aria-live="polite" className="project-workspace-stale" hidden={!statusMessage}>
      {error ? <>Connection to the Node API was lost. Showing the last known project list; some information may be out of date. <button className="history-button" type="button" onClick={load} disabled={loading}>{loading ? "Connecting…" : "Reload directory"}</button></> : statusMessage}
    </p>
    <p role="status" aria-live="polite">{notice}</p>
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
            <span className="projects-section-count">{`${directory.projects.length} project${directory.projects.length === 1 ? "" : "s"}`}</span>
          </div>
          {!loading && !error && !directory.projects.length && <p className="agents-directory-state">No projects yet. Add a project to get started.</p>}
          <div className="agents-card-grid projects-card-grid">
            {directory.projects.map((project) => {
              const operation = operationFor(project);
              return <ProjectCard key={project.project_id} project={project} admitted={selection.projects.some((entry) => entry.project_id === project.project_id)}
                operation={operation} onRetry={retryAdd}>
                {operation && <ProjectOperationStatus operation={operation} connectionError={lifecycle.errors[operation.request_key]} retryable={project.retryable} onChange={load} />}
              </ProjectCard>;
            })}
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
    <section aria-label="Tracked operations">
      {Object.values(lifecycle.pending).filter((intent) => !directory.projects.some((project) => project.root === intent.root)).map((intent) =>
        <ProjectOperationStatus key={intent.request_key} intent={intent} operation={lifecycle.operations[intent.request_key]} connectionError={lifecycle.errors[intent.request_key]} onChange={load} />)}
    </section>
    <Dialog open={adding} onClose={() => { if (!saving) setAdding(false); }} labelledBy="project-add-title" panelStyle={{ width: "min(520px, calc(100vw - 32px))", borderRadius: 0, background: "var(--app-panel)" }}>
      <div className="agent-modal project-add-modal">
        <header><div><p className="eyebrow">WORKSPACE</p><h2 id="project-add-title">Create or Add project</h2></div><button className="agent-modal-close" type="button" aria-label="Close" onClick={() => setAdding(false)} disabled={saving}>×</button></header>
        <form onSubmit={submit}>
          <label>Action<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="create">Create</option><option value="add">Add</option></select></label>
          <label>Absolute server path<input name="root" required aria-invalid={Boolean(formError)} aria-describedby="project-path-help project-field-error" placeholder="/home/data/sites/my-project" value={root} onChange={(event) => { setRoot(event.target.value); setFormError(""); }} /></label>
          <p id="project-path-help">This path is on the Node server.</p>
          {formError && <p id="project-field-error" className="agent-form-error" role="alert" data-error="field">{formError}</p>}
          <div className="agent-modal-actions"><button className="history-button" type="button" onClick={() => setAdding(false)} disabled={saving}>Cancel</button><button className="history-button agent-submit-button" type="submit" disabled={saving}>{saving ? "Submitting…" : kind === "create" ? "Create project" : "Add project"}</button></div>
        </form>
      </div>
    </Dialog>
  </div>;
}
