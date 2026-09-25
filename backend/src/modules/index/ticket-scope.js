// Summary: Resolves ticket-scoped search context from AC text and dependency tickets.
const PATH_TOKEN = /^(?:backend|schemas|ui|web)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

// Marks candidate_files entries auto-attached for pre-enforcement tickets.
// Retrieval treats marked entries as absent so schema placeholders never consume live search slots.
export const LEGACY_BACKFILL_REASON_PREFIX = "legacy-backfill:";

// Extracts explicit repo paths named in ticket title/objective/AC.
export function extractExplicitPaths(ticket) {
  const texts = [ticket?.title, ticket?.objective, ...(ticket?.acceptance_criteria ?? [])];
  const found = [];
  for (const text of texts) {
    if (typeof text !== "string") continue;
    for (const token of text.split(/[^A-Za-z0-9._/-]+/)) {
      if (PATH_TOKEN.test(token) && !token.startsWith(".") && token.includes("/") && !found.includes(token)) found.push(token);
    }
  }
  return found;
}

// Builds a schema-valid ticket from a pre-enforcement legacy ticket by inferring
// style and attaching a marked placeholder candidate. Marked entries are ignored
// by retrieval, so the next real run re-discovers candidates via live search.
export function backfillTicketCandidates(ticket, { now = () => new Date().toISOString() } = {}) {
  if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) return ticket;
  const normalized = { ...ticket };
  if (!Array.isArray(normalized.style) || normalized.style.length === 0) {
    normalized.style = inferTicketStyle(normalized) ?? ["backend"];
  }
  if (!Array.isArray(normalized.candidate_files) || normalized.candidate_files.length === 0) {
    normalized.candidate_files = [{ path: "backend/src/application/ticket-crud-service.js", role: "REFERENCE", reason: `${LEGACY_BACKFILL_REASON_PREFIX} pre-enforcement ticket; retrieval must re-discover via live search.` }];
    if (!normalized.candidates_produced_by) normalized.candidates_produced_by = "legacy-backfill";
    if (!normalized.candidates_produced_at) normalized.candidates_produced_at = now();
  } else {
    normalized.candidate_files = normalized.candidate_files.map(downgradeMissingSymbol);
  }
  return normalized;
}

// Downgrades a PATCH/REUSE entry missing its schema-required symbol to REFERENCE
// so pre-enforcement entries (saved before symbol became required) stop blocking
// roadmap persistence for every other ticket sharing the same sprint/roadmap.
function downgradeMissingSymbol(entry) {
  const hasSymbol = typeof entry?.symbol === "string" && entry.symbol.trim().length > 0;
  if ((entry?.role !== "PATCH" && entry?.role !== "REUSE") || hasSymbol) return entry;
  const reason = typeof entry.reason === "string" && entry.reason ? entry.reason : "no symbol recorded";
  return { ...entry, role: "REFERENCE", reason: `${LEGACY_BACKFILL_REASON_PREFIX} missing symbol for ${entry.role}; ${reason}` };
}

// Checks whether a candidate entry is a legacy-backfill placeholder.
export function isLegacyBackfillCandidate(entry) {
  return typeof entry?.reason === "string" && entry.reason.startsWith(LEGACY_BACKFILL_REASON_PREFIX);
}

// Infers ticket style keywords shared by prose intake and legacy backfill.
export function inferTicketStyle(ticket) {
  const text = [ticket?.title, ticket?.objective, ...(ticket?.acceptance_criteria ?? [])].filter((value) => typeof value === "string").join(" ").toLowerCase();
  const styles = new Set();
  if (/\b(frontend|front-end|ui\b|component|page\b|accordion|modal|chat.*ui|home chat)\b/.test(text)) styles.add("frontend");
  if (/\b(backend|back-end|api\b|endpoint|database|\bdb\b|sqlite|server\b)\b/.test(text)) styles.add("backend");
  if (/\b(security|auth|permission|credential|secret|token)\b/.test(text)) styles.add("security");
  if (/\b(infra|deploy|docker|ci\/cd|pipeline)\b/.test(text)) styles.add("infra");
  if (/\b(docs|documentation|readme|guide)\b/.test(text)) styles.add("docs");
  return styles.size ? [...styles] : undefined;
}

// Loads files_changed from finished dependency tickets' final reports.
export async function resolveDependencyFiles(ticket, { protocolStorage } = {}) {
  const ids = Array.isArray(ticket?.dependencies) ? ticket.dependencies : [];
  if (!ids.length || typeof protocolStorage?.get !== "function") return [];
  const files = [];
  for (const depId of ids) {
    if (typeof depId !== "string" || !depId) continue;
    try {
      const report = (await protocolStorage.get(`task/${depId}/final_report`))?.data;
      for (const entry of report?.files_changed ?? []) {
        const path = typeof entry === "string" ? entry : entry?.path;
        if (typeof path === "string" && path && !files.includes(path)) files.push(path);
      }
    // eslint-disable-next-line no-silent-catch -- Missing report means the dependency has no recorded files yet.
    } catch { /* missing report means dependency has no recorded files yet */ }
  }
  return files;
}

// Builds the full ticket scope: explicit paths first, dependency files second.
export async function resolveTicketScope(ticket, deps = {}) {
  const explicitPaths = extractExplicitPaths(ticket);
  const dependencyFiles = await resolveDependencyFiles(ticket, deps);
  return { explicitPaths, dependencyFiles };
}
