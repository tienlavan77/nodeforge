// Resolves ticket file scope and governed path prefixes for agent execution.
import { isLegacyBackfillCandidate } from "../index/ticket-scope.js";

// Selects traced PATCH/REUSE candidates and derives their allowed prefixes.
export function ticketCandidateScope(ticket) {
  const files = Array.isArray(ticket?.candidate_files) ? ticket.candidate_files : [];
  const real = files.filter((entry) =>
    entry && typeof entry.path === "string" && entry.path
    && (entry.role === "PATCH" || entry.role === "REUSE")
    && !isLegacyBackfillCandidate(entry)
  );
  if (!real.length) return null;
  const rank = (role) => role === "PATCH" ? 0 : 1;
  const ordered = [...real].sort((a, b) => rank(a.role) - rank(b.role));
  const targetPath = ordered[0]?.path ?? null;
  const allowedPrefixes = [...new Set(ordered.flatMap((entry) => prefixForPath(entry.path)))];
  return { targetPath, allowedPrefixes };
}

// Finds an explicit implementation path in ticket objective text.
export function ticketTargetPath(ticket) {
  return ticketExplicitTargetPath(ticket) ?? inferredUiTargetPath(ticket);
}

// Finds a concrete target explicitly named in the ticket text.
export function ticketExplicitTargetPath(ticket) {
  const candidates = [ticket?.objective, ...(ticket?.acceptance_criteria ?? [])];
  const paths = candidates.flatMap((text) => {
    if (typeof text !== "string") return [];
    return text
      .split(/[^A-Za-z0-9._/-]+/)
      .map((token) => token.replace(/[.,;:]+$/, ""))
      .filter((token) => /^(?:backend|schemas|ui|web)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(token) && !token.startsWith(".") && token.includes("/"));
  });
  return paths[0] ?? null;
}

// Combines ticket text fields for scope classification.
export function ticketText(ticket) {
  return [ticket?.title, ticket?.objective, ...(ticket?.acceptance_criteria ?? [])]
    .filter((value) => typeof value === "string")
    .join(" ");
}

// Detects UI-oriented tickets that need frontend prefixes.
export function isUiTicket(ticket) {
  if ((ticket?.implementation_type ?? ticket?.style)?.includes("frontend")) return true;
  return /\b(ui|frontend|front-end|react|next(?:\.js)?|component|page|button|layout|watcher|header|screen|responsive|status(?: area| line)?|dashboard|modal)\b/i.test(ticketText(ticket));
}

// Derives the directory prefix for an explicit file path.
export function prefixForPath(path) {
  if (typeof path !== "string") return [];
  const separator = path.lastIndexOf("/");
  return separator > 0 ? [path.slice(0, separator)] : [];
}

// Detects server-side tickets that require backend implementation access.
export function isBackendTicket(ticket) {
  if ((ticket?.implementation_type ?? ticket?.style)?.includes("backend")) return true;
  const text = ticketScopeText(ticket);
  if (/\b(backend|back-end|server|endpoint|api|database|sqlite|request payload)\b/i.test(text)) return true;
  return /\b(persist|persistence)\b/i.test(text) && /\b(database|db|sqlite|server|backend|back-end)\b/i.test(text);
}

// Excludes explicit out-of-scope clauses before deriving implementation permissions.
export function ticketScopeText(ticket) {
  return [ticket?.title, ticket?.objective, ...(ticket?.acceptance_criteria ?? [])]
    .filter((value) => typeof value === "string")
    .map((value) => value.replace(/\b(?:out of scope|excluded)\s*:[^.!?\n]*(?:[.!?]|$)/gi, " "))
    .join(" ");
}

// Derives governed prefixes from ticket language and file scope.
export function ticketAllowedPrefixes(ticket) {
  const prefixes = ["schemas/"];
  if (isUiTicket(ticket)) prefixes.push("ui/nextjs/", "ui/src/", "web/src/");
  if (isBackendTicket(ticket)) prefixes.push("backend/src/", "backend/tests/");
  return prefixes;
}

// Infers a concrete target for UI tickets with watcher process-status requirements.
export function inferredUiTargetPath(ticket) {
  const text = ticketText(ticket);
  return /\b(watcher|agent process status|pid|ram usage|cpu percentage|uptime)\b/i.test(text)
    ? "ui/nextjs/components/NodeForgePanels.jsx"
    : null;
}
