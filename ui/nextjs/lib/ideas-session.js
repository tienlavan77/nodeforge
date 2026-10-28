/**
 * Keeps notebook work in memory for the current UI session, partitioned by project.
 * Drafts and operation outcomes outlive panel mounts; no browser storage or logging
 * receives content or credentials. Reads can compare uncertain writes but never replay
 * them or infer the identity of an ambiguously committed create from matching text.
 */
const sessions = new Map();

/** Return the stable project store so navigation cannot transfer another project's work. */
export function getIdeasSession(projectId) {
  if (!sessions.has(projectId)) sessions.set(projectId, createSession(projectId));
  return sessions.get(projectId);
}

/** Own project data and reconcile asynchronous snapshots independently of panel visibility. */
export function createSession(projectId) {
  let state = { projectId, draft: { content: "", edit: null }, items: [], loaded: false,
    loading: false, saving: false, error: "", saved: false, conflict: null,
    comparison: null, uncertain: null };
  let revision = 0, readId = 0;
  const listeners = new Set();
  /** Publish immutable snapshots to all mounted views of this project's session. */
  function publish(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  /** Preserve input changes immediately, including changes arriving during a pending write. */
  function changeDraft(draft) {
    const cancelled = state.draft.edit && !draft.edit;
    publish({ draft, saved: false, ...(cancelled ? { conflict: null, comparison: null, error: state.uncertain ? state.error : "" } : {}) });
  }
  /** Read authoritative data without clearing edits, changing their version, or replaying writes. */
  async function load(client) {
    const request = ++readId;
    const uncertain = state.uncertain;
    publish({ loading: true, saved: false });
    try {
      let result, before;
      do {
        before = revision;
        result = await client.listIdeas({ projectId });
      } while (before !== revision && request === readId);
      if (request !== readId) return false;
      const items = Array.isArray(result) ? result : result?.items;
      if (!Array.isArray(items)) throw new Error("Invalid Ideas collection response");
      const reconciled = uncertain && state.uncertain === uncertain;
      publish({ items, loaded: true,
        error: state.uncertain ? reconciled ? ""
          : "Chưa xác nhận lưu. Cần tải lại dữ liệu sau lỗi trước khi gửi lại." : state.conflict ? state.error : "" });
      if (reconciled) publish({ uncertain: { ...uncertain, checked: true } });
      return true;
    } catch (failure) {
      if (request === readId) publish({ error: "Chưa xác nhận lưu. Không thể tải dữ liệu: " + failure.message });
      return false;
    } finally { if (request === readId) publish({ loading: false }); }
  }
  /** Fetch a conflicting server record alongside the unchanged local edit and original version. */
  async function compare(client) {
    const conflict = state.conflict;
    if (!conflict) return;
    publish({ loading: true });
    try {
      const item = await client.getIdea({ projectId, id: conflict.id });
      if (state.conflict === conflict) publish({ comparison: item ?? { content: "Không còn bản server." } });
    } catch (failure) { publish({ error: "Xung đột. Không thể tải bản server: " + failure.message }); }
    finally { publish({ loading: false }); }
  }
  /** Send one explicit user operation; failures retain its snapshot and require read-before-retry.
   * A read never proves which create belongs to a lost response, so uncertainty remains visible.
   * Successful edits retain later typing and its original version rather than silently rebasing.
   */
  async function mutate(client, kind, item) {
    if (state.saving || (state.loading && state.uncertain)) return false;
    if (state.uncertain && !state.uncertain.checked) { await load(client); return false; }
    const draft = state.draft;
    const submitted = kind === "create" ? draft.content : item?.content;
    publish({ saving: true, saved: false, error: "", comparison: null, conflict: null });
    try {
      let result;
      if (kind === "create") result = await client.createIdea({ projectId, content: submitted });
      else if (kind === "delete") result = await client.deleteIdea({ projectId, id: item.id, expected_version: item.version });
      else result = await client.updateIdea({ projectId, id: item.id, expected_version: item.version,
        ...(kind === "edit" ? { content: submitted } : { status: item.status === "done" ? "open" : "done" }) });
      revision++;
      let nextDraft = state.draft;
      if (kind === "create" && nextDraft.content === submitted && nextDraft === draft) nextDraft = { ...nextDraft, content: "" };
      if (kind === "edit" && nextDraft.edit === item) nextDraft = { ...nextDraft, edit: null };
      const items = kind === "create" ? [...state.items, result] : kind === "delete"
        ? state.items.filter(entry => entry.id !== item.id)
        : state.items.map(entry => entry.id === result.id ? result : entry);
      const queue = state.uncertain ? [state.uncertain, ...(state.uncertain.pending ?? [])] : [];
      const remaining = queue.filter(entry => entry.kind !== kind || entry.id !== item?.id);
      const uncertain = remaining.length === queue.length ? state.uncertain : remaining[0]
        ? { kind: remaining[0].kind, id: remaining[0].id, checked: state.uncertain.checked,
          ...(remaining.length > 1 ? { pending: remaining.slice(1) } : {}) } : null;
      // An unrelated acknowledgement cannot resolve a previously lost response.
      publish({ items, draft: nextDraft, uncertain, saved: !uncertain });
      return true;
    } catch (failure) {
      if (failure.status === 409) publish({ conflict: { id: item?.id, kind },
        error: "Xung đột phiên bản. Bản nháp được giữ nguyên; tải bản server để đối chiếu." });
      else {
        // Retain the oldest unresolved identity and every later uncertain operation.
        // A fresh failure invalidates reconciliation; the next attempt must read again.
        publish({ uncertain: state.uncertain
          ? { ...state.uncertain, checked: false,
            pending: [...(state.uncertain.pending ?? []), { kind, id: item?.id }] }
          : { kind, id: item?.id, checked: false },
          error: "Chưa xác nhận lưu. Bản nháp được giữ nguyên. " + failure.message });
      }
      return false;
    } finally { publish({ saving: false }); }
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    changeDraft, load, compare, mutate
  };
}
