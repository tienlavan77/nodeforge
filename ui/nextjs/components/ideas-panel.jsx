/**
 * Renders the project's floating notebook independently of conversation messages and agent work.
 * The dock retains this component while hidden, and a session map restores unfinished entries
 * if workspace navigation recreates the dock. Requests use the project-bound client and saved
 * server versions. Success feedback is published only after a mutation response is received.
 */
"use client";
import { useEffect, useRef, useState } from "react";

/** Retain unfinished notebook inputs for each project for the lifetime of this browser session. */
const drafts = new Map();

/** Present accessible quick entry and versioned CRUD, leaving conversation and SSE ownership untouched. */
export function IdeasPanel({ client, projectId, open, onClose, panelId }) {
  const [draft, setDraft] = useState(() => drafts.get(projectId) ?? { content: "", edit: null });
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const input = useRef(null);
  // Preserve the stable delete trigger when its temporary confirmation controls disappear.
  const deleteButton = useRef(null);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  /** Persist inputs before a render so closing or navigating cannot discard the user's unfinished work. */
  function changeDraft(next) {
    drafts.set(projectId, next); currentDraft.current = next; setDraft(next); setSaved(false);
  }
  /** Reload authoritative records after an error without automatically replaying a possibly committed mutation. */
  async function load() {
    setLoading(true); setError(""); setSaved(false);
    try {
      const result = await client.listIdeas({ projectId });
      setItems(Array.isArray(result) ? result : result.items ?? []);
      setLoaded(true);
    } catch (failure) { setError(failure.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (open && !loaded && !loading && !error) void load(); }, [open, loaded, loading, error]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  /** Apply only confirmed backend changes and keep the input snapshot intact when a request fails. */
  async function mutate(operation, apply) {
    setSaving(true); setSaved(false); setError("");
    try { const result = await operation(); apply(result); setSaved(true); }
    catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  }
  /** Capture the submitted entry and clear it only when no newer text has replaced that snapshot. */
  function create(event) {
    event.preventDefault();
    const submitted = draft.content;
    if (!submitted.trim() || saving) return;
    void mutate(() => client.createIdea({ projectId, content: submitted }), (item) => {
      setItems((previous) => [...previous, item]);
      if (currentDraft.current.content === submitted) changeDraft({ ...currentDraft.current, content: "" });
    });
  }
  /** Save the original edit version rather than silently adopting a newer server version. */
  function saveEdit(event) {
    event.preventDefault();
    const edit = draft.edit;
    if (!edit?.content.trim() || saving) return;
    void mutate(() => client.updateIdea({ projectId, id: edit.id, content: edit.content, expected_version: edit.version }), (item) => {
      setItems((previous) => previous.map((entry) => entry.id === item.id ? item : entry));
      if (currentDraft.current.edit === edit) changeDraft({ ...currentDraft.current, edit: null });
    });
  }
  /** Toggle workflow status with the exact version displayed to the user. */
  function toggle(item) {
    void mutate(() => client.updateIdea({ projectId, id: item.id, status: item.status === "done" ? "open" : "done", expected_version: item.version }),
      (updated) => setItems((previous) => previous.map((entry) => entry.id === updated.id ? updated : entry)));
  }
  /** Delete only after an explicit inline confirmation, then return focus to quick entry. */
  function confirmDelete(item) {
    void mutate(() => client.deleteIdea({ projectId, id: item.id, expected_version: item.version }), () => {
      setItems((previous) => previous.filter((entry) => entry.id !== item.id));
      setDeleting(null); input.current?.focus();
    });
  }
  return <section id={panelId} className="ideas-panel" aria-label="Ý tưởng" hidden={!open}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header><h2>Ý tưởng</h2><button type="button" onClick={onClose} aria-label="Đóng Ý tưởng">×</button></header>
    <p className="ideas-project">Project: {projectId}</p>
    <form onSubmit={create}>
      <label htmlFor={panelId + "-entry"}>Ý tưởng mới</label>
      <textarea ref={input} id={panelId + "-entry"} value={draft.content}
        onChange={(event) => changeDraft({ ...draft, content: event.target.value })} />
      <button disabled={saving || !draft.content.trim()} type="submit">Thêm ý tưởng</button>
    </form>
    <div role="status" aria-live="polite">{loading ? "Đang tải…" : saving ? "Đang lưu…" : saved ? "Đã lưu" : ""}</div>
    {error && <div role="alert"><p>{error}</p><button type="button" disabled={loading || saving} onClick={() => void load()}>Thử lại</button></div>}
    {loaded && !loading && !items.length && <p>Chưa có ý tưởng.</p>}
    <ul aria-label="Danh sách ý tưởng" aria-busy={loading || saving}>
      {items.map((item) => <li key={item.id} data-idea-id={item.id}>
        {draft.edit?.id === item.id ? <form onSubmit={saveEdit}>
          <label htmlFor={panelId + "-edit"}>Sửa nội dung</label>
          <textarea id={panelId + "-edit"} value={draft.edit.content}
            onChange={(event) => changeDraft({ ...draft, edit: { ...draft.edit, content: event.target.value } })} />
          <button type="submit" disabled={saving || !draft.edit.content.trim()}>Lưu nội dung</button>
          <button type="button" disabled={saving} onClick={() => changeDraft({ ...draft, edit: null })}>Hủy sửa</button>
        </form> : <><p>{item.content}</p><span>{item.status === "done" ? "Đã xong" : "Đang mở"}</span>
          <div className="ideas-actions">
            <button type="button" disabled={saving} onClick={() => changeDraft({ ...draft, edit: { ...item } })}>Sửa</button>
            <button type="button" disabled={saving} onClick={() => toggle(item)}>{item.status === "done" ? "Mở lại" : "Hoàn thành"}</button>
            <button type="button" disabled={saving} onClick={(event) => { deleteButton.current = event.currentTarget; setDeleting(item.id); }}>Xóa</button>
          </div></>}
        {deleting === item.id && <div role="group" aria-label="Xác nhận xóa">
          <p>Xóa ý tưởng này?</p>
          <button type="button" disabled={saving} onClick={() => confirmDelete(item)}>Xác nhận xóa</button>
          <button type="button" disabled={saving} onClick={() => { setDeleting(null); deleteButton.current?.focus(); }}>Hủy xóa</button>
        </div>}
      </li>)}
    </ul>
  </section>;
}
