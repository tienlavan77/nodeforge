// Summary: Resolves ticket-scoped search context from AC text and dependency tickets.
const PATH_TOKEN = /^(?:backend|schemas|ui|web)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

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
