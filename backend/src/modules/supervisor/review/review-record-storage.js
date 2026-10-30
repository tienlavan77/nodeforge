// Stores new ticket review histories as immutable records behind one atomic, recoverable index.
import { statePath } from "../../../infrastructure/filesystem/forge-paths.js";
import { reviewRecordHash } from "./review-record-identity.js";
import { reviewQueryRecord, reviewQueryRecords, redactReviewRecord } from "./review-query-records.js";
export { reviewRecordHash } from "./review-record-identity.js";

const collections = ["findings", "coder_reports", "coder_responses", "adjudications", "coder_report_drafts", "rejected_coder_reports"];

// Creates project-local storage; existing legacy tickets keep their original format without migration.
export function createReviewRecordStorage({ taskId, fileService }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(taskId ?? "")) throw new Error("Invalid review ticket identity.");
  const legacyPath = `${statePath()}/ticket-review-findings/${taskId}.json`;
  const root = `${statePath()}/review-records/${taskId}`;
  const indexPath = `${root}/index.json`;
  const backupPath = `${root}/index-backup.json`;
  return { load, loadQuery, queryRecords, findingBindings, save, indexPath };

  // Reads a missing index as empty, while surfacing corrupt or inaccessible evidence.
  async function read(path) {
    try { return JSON.parse(await fileService.readFile({ path })); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  // Recovers the last fully published index without treating pre-commit orphan records as accepted history.
  async function readIndex() {
    let primaryError;
    try {
      const index = await read(indexPath);
      if (index) {
        if (index.format !== "review-records-v1" || index.state?.task_id !== taskId || !index.collections || !Array.isArray(index.catalog))
          throw Object.assign(new Error("Review index shape is invalid."), { code: "REVIEW_INDEX_CORRUPT" });
        return index;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && error.code !== "REVIEW_INDEX_CORRUPT") throw error;
      primaryError = error;
    }
    const backup = await read(backupPath);
    if (backup) {
      if (backup.format !== "review-records-v1" || backup.state?.task_id !== taskId || !backup.collections || !Array.isArray(backup.catalog))
        throw Object.assign(new Error("Published review index backup is corrupt."), { code: "REVIEW_INDEX_CORRUPT" });
      console.warn(`Review index recovered from its published backup for ${taskId}.`);
      return backup;
    }
    if (primaryError) throw primaryError;
    return null;
  }

  // Resolves only hash-addressed records from the current ticket's committed index.
  async function expand(ref) {
    if (!collections.includes(ref?.kind) || !/^[a-f0-9]{64}$/.test(ref?.hash ?? "")) throw new Error("Invalid review record reference.");
    const record = await read(`${root}/${ref.kind}/${ref.hash}.json`);
    if (!record || reviewRecordHash(record) !== ref.hash) throw new Error("Review record is missing or corrupt.");
    const value = { ...record.value };
    for (const [key, refs] of Object.entries(record.children)) value[key] = await Promise.all(refs.map(expand));
    return value;
  }

  // Reconstructs the existing store contract without copying historical payloads into its index.
  async function load() {
    const legacy = await read(legacyPath);
    if (legacy) return legacy;
    const index = await readIndex();
    if (!index) return null;
    return hydrate(index);
  }

  // Reconstructs one consistent index snapshot for existing workflow consumers.
  async function hydrate(index) {
    const state = { ...index.state };
    for (const [key, refs] of Object.entries(index.collections)) state[key] = await Promise.all(refs.map(expand));
    return state;
  }

  // Exposes every recorded finding revision to exact lookup without changing workflow state.
  async function loadQuery() {
    const legacy = await read(legacyPath);
    if (legacy) return legacy;
    const index = await readIndex();
    if (!index) return null;
    const state = await hydrate(index);
    state.query_finding_revisions = {};
    for (const [id, refs] of Object.entries(index.finding_revisions ?? {})) state.query_finding_revisions[id] = await Promise.all(refs.map(expand));
    return state;
  }

  // Uses the metadata index to read exact records without hydrating the entire new-format history.
  async function queryRecords(input) {
    const legacy = await read(legacyPath);
    if (legacy) return reviewQueryRecords(legacy);
    const index = await readIndex();
    if (!index) return [];
    let selected = index.catalog.filter((entry) => ["kind", "id", "revision", "commit_sha", "status"].every((key) => input[key] === undefined || entry[key] === input[key])
      && (!input.finding_id || entry.finding_ids.includes(input.finding_id)));
    if (input.action === "get") selected = selected.slice(-1);
    return Promise.all(selected.map(async (entry) => {
      const { ref, ...metadata } = entry;
      const body = input.action === "get" || input.query ? redactReviewRecord(await expand(ref)) : {};
      return { ...metadata, body };
    }));
  }

  // Captures exact finding revisions in Node-owned response and adjudication receipts.
  async function findingBindings(ids) {
    const records = await queryRecords({ action: "search", kind: "finding" });
    const bindings = {};
    for (const record of records) if (ids.includes(record.id)) bindings[record.id] = {
      revision: record.revision, record_sha256: record.record_sha256
    };
    return bindings;
  }

  // Writes immutable children first; crashes leave harmless orphans and the previous valid index.
  async function pack(value, kind) {
    const content = { ...value }, children = {};
    for (const key of ["history", "refinements", "submissions"]) if (Array.isArray(content[key])) {
      children[key] = await Promise.all(content[key].map((entry) => pack(entry, kind)));
      delete content[key];
    }
    const record = { value: content, children }, hash = reviewRecordHash(record);
    const path = `${root}/${kind}/${hash}.json`;
    const existing = await read(path);
    if (existing && reviewRecordHash(existing) !== hash) throw new Error("Immutable review record conflict.");
    if (!existing) {
      try { await fileService.atomicWrite({ path, content: `${JSON.stringify(record)}\n`, replace: false }); }
      catch (error) {
        if (error.code !== "FILE_ALREADY_EXISTS" || reviewRecordHash(await read(path)) !== hash) throw error;
      }
    }
    return { kind, hash };
  }

  // Commits all new references atomically under the finding store's existing ticket lock.
  async function save(state) {
    if (await read(legacyPath)) {
      await fileService.atomicWrite({ path: legacyPath, content: `${JSON.stringify(state)}\n`, replace: true });
      return;
    }
    const previous = await readIndex();
    const index = { format: "review-records-v1", state: { ...state }, collections: {}, finding_revisions: { ...previous?.finding_revisions }, catalog: [...(previous?.catalog ?? [])] };
    for (const finding of state.findings ?? []) {
      const current = { ...finding }; delete current.history; delete current.refinements;
      const ref = await pack(current, "findings");
      const revisions = [...(index.finding_revisions[finding.finding_id] ?? [])];
      if (revisions.at(-1)?.hash !== ref.hash) revisions.push(ref);
      index.finding_revisions[finding.finding_id] = revisions;
      publish("finding", finding.finding_id, current, ref, [finding.finding_id]);
    }
    for (const key of collections) if (Array.isArray(state[key])) {
      index.collections[key] = await Promise.all(state[key].map((entry) => pack(entry, key)));
      delete index.state[key];
      const kind = { coder_reports: "report", coder_responses: "response", adjudications: "adjudication", coder_report_drafts: "draft", rejected_coder_reports: "rejected_report" }[key];
      if (kind) for (let position = 0; position < state[key].length; position++) {
        const value = state[key][position];
        publish(kind, value.idempotency_key ?? value.artifact_id ?? reviewRecordHash(value), value, index.collections[key][position],
          value.finding_id ? [value.finding_id] : (value.responses ?? []).map((entry) => entry.finding_id));
      }
    }
    const content = `${JSON.stringify(index)}\n`;
    await fileService.atomicWrite({ path: indexPath, content, replace: true });
    await fileService.atomicWrite({ path: backupPath, content, replace: true });

    // Adds a searchable revision only when its immutable content changes.
    function publish(kind, id, value, ref, findingIds) {
      const last = index.catalog.findLast((entry) => entry.kind === kind && entry.id === id);
      if (last?.ref.hash === ref.hash) return;
      const metadata = reviewQueryRecord(kind, id, (last?.revision ?? 0) + 1, value, findingIds);
      delete metadata.body;
      index.catalog.push({ ...metadata, ref });
    }
  }
}
