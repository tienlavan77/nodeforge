"use client";

/**
 * Renders the project-scoped Notebook floating panel inside the Architecture Manager workspace.
 * Quick entry stays above the list, and drafts/conflict state remain bound to the active project.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getNotebookSession } from "../lib/notebook-session.js";

/** Present accessible quick entry and versioned CRUD, leaving conversation and SSE ownership untouched. */
export function NotebookPanel({ client, projectId, open, onClose, panelId, minimized = false, isActive = true, onActivate, onToggleMinimize, onHeaderPointerDown, style, panelRef }) {
  const session = getNotebookSession(projectId);
  const { draft, items, loaded, loading, saving, error, saved, conflict, comparison, uncertain } =
    useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [deleting, setDeleting] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const input = useRef(null);
  // Preserve the stable delete trigger when its temporary confirmation controls disappear.
  const deleteButton = useRef(null);
  const changeDraft = session.changeDraft;
  const blocked = saving || (loading && Boolean(uncertain));
  const dragEnabled = !blocked && !draft.edit;
  useEffect(() => { if (open && !loaded && !loading && !error) void session.load(client); },
    [open, loaded, loading, error, session, client]);
  useEffect(() => { if (open && !minimized) input.current?.focus(); }, [open, minimized]);
  /** Capture the submitted entry and clear it only when no newer text has replaced that snapshot. */
  function create(event) {
    event.preventDefault();
    if (!draft.content.trim() || blocked) return;
    void session.mutate(client, "create");
  }
  /** Save the original edit version rather than silently adopting a newer server version. */
  function saveEdit(event) {
    event.preventDefault();
    if (!draft.edit?.content.trim() || blocked) return;
    void session.mutate(client, "edit", draft.edit);
  }
  /** Toggle workflow status with the exact version displayed to the user. */
  function toggle(item) { void session.mutate(client, "toggle", item); }
  /** Delete only after an explicit inline confirmation, then return focus to quick entry. */
  async function confirmDelete(item) {
    if (await session.mutate(client, "delete", item)) { setDeleting(null); input.current?.focus(); }
  }
  // Keep an edit visible even if a fresh server list no longer contains its record.
  const visibleItems = draft.edit && !items.some(item => item.id === draft.edit.id) ? [...items, draft.edit] : items;
  const openItems = visibleItems.filter(item => item.status !== "done");
  const doneItems = visibleItems.filter(item => item.status === "done");
  /**
   * Business purpose: Allows users to reorder Notebook items or drag a Notebook item between the open and completed lists while persisting the new order and status to the backend.
   * Technical description: Computes the target global position index in the project's Notebook collection and dispatches a reorder mutation with expected_version and optional status transition.
   */
  function dropNotebook(targetItem, targetStatus = targetItem?.status) {
    if (!dragEnabled || !draggingId) return;
    const source = items.find(entry => entry.id === draggingId);
    setDraggingId(null); setDragOverId(null);
    if (!source || (targetItem && source.id === targetItem.id && source.status === targetStatus)) return;
    const rest = items.filter(entry => entry.id !== source.id);
    let nextPosition = rest.length;
    if (targetItem) {
      const idx = rest.findIndex(entry => entry.id === targetItem.id);
      if (idx !== -1) nextPosition = idx;
    }
    const nextStatus = targetStatus && targetStatus !== source.status ? targetStatus : undefined;
    void session.mutate(client, "reorder", { ...source, position: nextPosition, ...(nextStatus ? { status: nextStatus } : {}) });
  }
  /**
   * Business purpose: Renders a single To-do item row with a completion checkbox, 15px content text (strikethrough when completed), compact right-side Edit/Delete icon buttons, inline edit form, and delete confirmation.
   * Technical description: Produces an accessible draggable list item element bound to item.id and versioned session mutations.
   */
  function renderNotebookItem(item) {
    const isDone = item.status === "done";
    return <li key={item.id} data-notebook-id={item.id} data-notebook-status={item.status}
      className={`notebook-todo-item${isDone ? " is-done" : ""}${draggingId === item.id ? " is-dragging" : ""}${dragOverId === item.id ? " is-drag-over" : ""}`}
      draggable={dragEnabled}
      onDragStart={(event) => {
        if (!dragEnabled) { event.preventDefault(); return; }
        setDraggingId(item.id);
        event.dataTransfer?.setData("text/plain", item.id);
      }}
      onDragOver={(event) => {
        if (!dragEnabled || !draggingId) return;
        event.preventDefault();
        if (dragOverId !== item.id) setDragOverId(item.id);
      }}
      onDrop={(event) => { event.preventDefault(); event.stopPropagation(); dropNotebook(item, item.status); }}
      onDragEnd={() => { setDraggingId(null); setDragOverId(null); }}>
      {draft.edit?.id === item.id ? <form onSubmit={saveEdit}>
        <label htmlFor={panelId + "-edit"}>Sửa nội dung</label>
        <textarea id={panelId + "-edit"} value={draft.edit.content}
          onChange={(event) => changeDraft({ ...draft, edit: { ...draft.edit, content: event.target.value } })} />
        <p>Phiên bản gốc: {draft.edit.version}</p>
        <button type="submit" disabled={blocked || !draft.edit.content.trim()}>Lưu nội dung</button>
        <button type="button" disabled={saving} onClick={() => changeDraft({ ...draft, edit: null })}>Hủy sửa</button>
      </form> : <div className="notebook-todo-row">
        <input type="checkbox" className="notebook-todo-checkbox" checked={isDone} disabled={blocked}
          aria-label={isDone ? "Mở lại" : "Hoàn thành"} title={isDone ? "Mở lại" : "Hoàn thành"}
          onChange={() => toggle(item)} />
        <p className={`notebook-todo-content${isDone ? " is-done" : ""}`}>{item.content}</p>
        <span className="notebook-status-badge" hidden>{isDone ? "Đã xong" : "Đang mở"}</span>
        <div className="notebook-actions">
          <button type="button" className="notebook-icon-btn" aria-label="Sửa" title="Sửa"
            disabled={blocked || Boolean(draft.edit)} onClick={() => changeDraft({ ...draft, edit: { ...item } })}>
            <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
              <path d="M8.5 1.5l2 2L4 10H2V8l6.5-6.5z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="button" className="notebook-icon-btn" aria-label="Xóa" title="Xóa"
            disabled={blocked} onClick={(event) => { deleteButton.current = event.currentTarget; setDeleting(item.id); }}>
            <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
              <path d="M2 3.2h8M4.5 3.2V2h3v1.2M3.2 3.2v6.3a.8.8 0 0 0 .8.8h4a.8.8 0 0 0 .8-.8V3.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>}
      {deleting === item.id && <div role="group" aria-label="Xác nhận xóa" className="notebook-delete-confirm">
        <p>Xóa sổ tay này?</p>
        <button type="button" disabled={blocked} onClick={() => void confirmDelete(item)}>Xác nhận xóa</button>
        <button type="button" disabled={saving} onClick={() => { setDeleting(null); deleteButton.current?.focus(); }}>Hủy xóa</button>
      </div>}
    </li>;
  }
  return <section ref={panelRef} id={panelId} data-monitor-name="notebook"
    data-monitor-active={isActive ? "true" : "false"}
    onPointerDown={() => onActivate?.()}
    onFocusCapture={() => onActivate?.()}
    className={`workspace-monitor notebook-panel${minimized ? " is-minimized" : ""}${isActive ? " is-active-panel" : " is-inactive-panel"}`}
    style={style} aria-label="Sổ tay" hidden={!open}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header className="workspace-monitor-header" onPointerDown={onHeaderPointerDown}>
      <strong>Sổ tay</strong>
      <button type="button" aria-label={minimized ? "Mở rộng Sổ tay" : "Thu gọn Sổ tay"} onClick={onToggleMinimize}>{minimized ? "□" : "−"}</button>
      <button type="button" onClick={onClose} aria-label="Đóng Sổ tay">×</button>
    </header>
    {!minimized && <div className="workspace-monitor-content notebook-panel-body">
      <form className="notebook-entry-form" onSubmit={create}>
        <label htmlFor={panelId + "-entry"}>Ghi chú mới</label>
        <textarea ref={input} id={panelId + "-entry"} value={draft.content}
          onChange={(event) => changeDraft({ ...draft, content: event.target.value })} />
        <button className="notebook-entry-submit" disabled={blocked || !draft.content.trim()} type="submit">Thêm sổ tay</button>
      </form>
      <div role="status" aria-live="polite">{loading ? "Đang tải…" : saving ? "Đang lưu…" : saved ? <><span>Đã lưu</span>{" bản đã gửi. Phần nhập mới vẫn là bản nháp."}</> : ""}</div>
      {error && <div role="alert"><p>{error}</p>
        {conflict && <button type="button" disabled={loading || saving} onClick={() => void session.compare(client)}>Tải bản server để đối chiếu</button>}
      </div>}
      {uncertain && <p role="note">Chưa xác nhận lưu. {uncertain.checked && "Đã tải dữ liệu để đối chiếu. "}{uncertain.kind === "create" ? "Không thể xác định chắc chắn sổ tay đã được tạo. Gửi lại có thể tạo bản trùng." : "Kiểm tra dữ liệu server trước khi gửi lại."}</p>}
      {comparison && <aside aria-label="Bản server"><h3>Bản server để đối chiếu</h3><p>{comparison.content}</p><p>Version: {comparison.version ?? "—"}</p></aside>}
      {loaded && !loading && !visibleItems.length && <p>Chưa có sổ tay.</p>}
      <div className="notebook-lists-container">
        <div className="notebook-list-section" data-list-status="open">
          <h4 className="notebook-list-heading">Chưa hoàn thành ({openItems.length})</h4>
          <ul aria-label="Danh sách sổ tay" data-notebook-list="open" aria-busy={loading || saving}
            onDragOver={(event) => { if (dragEnabled && draggingId) event.preventDefault(); }}
            onDrop={(event) => { event.preventDefault(); dropNotebook(null, "open"); }}>
            {openItems.map(renderNotebookItem)}
          </ul>
        </div>
        <div className="notebook-list-section" data-list-status="done">
          <h4 className="notebook-list-heading">Đã hoàn thành ({doneItems.length})</h4>
          <ul aria-label="Danh sách sổ tay đã hoàn thành" data-notebook-list="done" aria-busy={loading || saving}
            onDragOver={(event) => { if (dragEnabled && draggingId) event.preventDefault(); }}
            onDrop={(event) => { event.preventDefault(); dropNotebook(null, "done"); }}>
            {doneItems.map(renderNotebookItem)}
          </ul>
        </div>
      </div>
    </div>}
  </section>;
}
