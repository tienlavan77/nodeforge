/**
 * Renders the project's floating notebook independently of conversation messages and agent work.
 * The dock retains this component while hidden, and a session map restores unfinished entries
 * if workspace navigation recreates the dock. Requests use the project-bound client and saved
 * server versions. Success feedback is published only after a mutation response is received.
 */
"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getIdeasSession } from "../lib/ideas-session.js";

/** Present accessible quick entry and versioned CRUD, leaving conversation and SSE ownership untouched. */
export function IdeasPanel({ client, projectId, open, onClose, panelId }) {
  const session = getIdeasSession(projectId);
  const { draft, items, loaded, loading, saving, error, saved, conflict, comparison, uncertain } =
    useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [deleting, setDeleting] = useState(null);
  const input = useRef(null);
  // Preserve the stable delete trigger when its temporary confirmation controls disappear.
  const deleteButton = useRef(null);
  const changeDraft = session.changeDraft;
  const blocked = saving || (loading && Boolean(uncertain));
  useEffect(() => { if (open && !loaded && !loading && !error) void session.load(client); },
    [open, loaded, loading, error, session, client]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
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
  return <section id={panelId} className="ideas-panel" aria-label="Ý tưởng" hidden={!open}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header><h2>Ý tưởng</h2><button type="button" onClick={onClose} aria-label="Đóng Ý tưởng">×</button></header>
    <p className="ideas-project">Project: {projectId}</p>
    <form onSubmit={create}>
      <label htmlFor={panelId + "-entry"}>Ý tưởng mới</label>
      <textarea ref={input} id={panelId + "-entry"} value={draft.content}
        onChange={(event) => changeDraft({ ...draft, content: event.target.value })} />
      <button disabled={blocked || !draft.content.trim()} type="submit">Thêm ý tưởng</button>
    </form>
    <div role="status" aria-live="polite">{loading ? "Đang tải…" : saving ? "Đang lưu…" : saved ? <><span>Đã lưu</span>{" bản đã gửi. Phần nhập mới vẫn là bản nháp."}</> : ""}</div>
    {error && <div role="alert"><p>{error}</p>
      <button type="button" disabled={loading || saving} onClick={() => void session.load(client)}>Thử lại</button>
      {conflict && <button type="button" disabled={loading || saving} onClick={() => void session.compare(client)}>Tải bản server để đối chiếu</button>}
    </div>}
    {uncertain && <p role="note">Chưa xác nhận lưu. {uncertain.checked && "Đã tải dữ liệu để đối chiếu. "}{uncertain.kind === "create" ? "Không thể xác định chắc chắn ý tưởng đã được tạo. Gửi lại có thể tạo bản trùng." : "Kiểm tra dữ liệu server trước khi gửi lại."}</p>}
    {comparison && <aside aria-label="Bản server"><h3>Bản server để đối chiếu</h3><p>{comparison.content}</p><p>Version: {comparison.version ?? "—"}</p></aside>}
    {loaded && !loading && !visibleItems.length && <p>Chưa có ý tưởng.</p>}
    <ul aria-label="Danh sách ý tưởng" aria-busy={loading || saving}>
      {visibleItems.map((item) => <li key={item.id} data-idea-id={item.id}>
        {draft.edit?.id === item.id ? <form onSubmit={saveEdit}>
          <label htmlFor={panelId + "-edit"}>Sửa nội dung</label>
          <textarea id={panelId + "-edit"} value={draft.edit.content}
            onChange={(event) => changeDraft({ ...draft, edit: { ...draft.edit, content: event.target.value } })} />
          <p>Phiên bản gốc: {draft.edit.version}</p>
          <button type="submit" disabled={blocked || !draft.edit.content.trim()}>Lưu nội dung</button>
          <button type="button" disabled={saving} onClick={() => changeDraft({ ...draft, edit: null })}>Hủy sửa</button>
        </form> : <><p>{item.content}</p><span>{item.status === "done" ? "Đã xong" : "Đang mở"}</span>
          <div className="ideas-actions">
            <button type="button" disabled={blocked || Boolean(draft.edit)} onClick={() => changeDraft({ ...draft, edit: { ...item } })}>Sửa</button>
            <button type="button" disabled={blocked} onClick={() => toggle(item)}>{item.status === "done" ? "Mở lại" : "Hoàn thành"}</button>
            <button type="button" disabled={blocked} onClick={(event) => { deleteButton.current = event.currentTarget; setDeleting(item.id); }}>Xóa</button>
          </div></>}
        {deleting === item.id && <div role="group" aria-label="Xác nhận xóa">
          <p>Xóa ý tưởng này?</p>
          <button type="button" disabled={blocked} onClick={() => void confirmDelete(item)}>Xác nhận xóa</button>
          <button type="button" disabled={saving} onClick={() => { setDeleting(null); deleteButton.current?.focus(); }}>Hủy xóa</button>
        </div>}
      </li>)}
    </ul>
  </section>;
}
