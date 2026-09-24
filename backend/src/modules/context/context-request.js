// Normalizes context requests and their role-based token budgets.
import { ConfigurationError } from "../../shared/errors.js";

// Normalizes varied request shapes into a canonical context request.
export function normalizeRequest(request) {
  const symbols = (request.symbols ?? (request.symbol ? [request.symbol] : [])).map((selector) => typeof selector === "string" ? { name: selector } : selector);
  const lineRanges = request.line_ranges ?? request.lineRanges ?? [];
  const paths = request.paths ?? (request.path ? [request.path] : []);
  if (typeof request.task_id !== "string" && typeof request.taskId !== "string") throw new ConfigurationError("Context request requires task_id.");
  if (symbols.some(({ name }) => typeof name !== "string" || name.length === 0)) throw new ConfigurationError("Context symbol selectors require a name.");
  for (const range of lineRanges) {
    if (typeof range?.path !== "string" || !Number.isInteger(range.start_line ?? range.start) || !Number.isInteger(range.end_line ?? range.end)) throw new ConfigurationError("Context line ranges require path, start_line, and end_line.");
    const start = range.start_line ?? range.start;
    const end = range.end_line ?? range.end;
    if (start < 1 || end < start) throw new ConfigurationError("Context line range is invalid.");
  }
  return {
    taskId: request.task_id ?? request.taskId,
    sessionId: request.session_id ?? request.sessionId,
    purpose: request.purpose ?? "custom",
    symbols,
    lineRanges: lineRanges.map((range) => ({ path: range.path, start: range.start_line ?? range.start, end: range.end_line ?? range.end })),
    paths,
    includeDependencies: request.include_dependencies ?? request.includeDependencies ?? true,
    expectedIndexVersion: request.index_version ?? request.indexVersion,
    maxTokens: request.budget?.max_tokens ?? request.max_tokens ?? defaultBudget(request)
  };
}

// Chooses a default token budget based on agent role.
function defaultBudget(request) {
  const role = String(request.agent_role ?? request.agentRole ?? request.domain ?? "").toLowerCase();
  if (role.includes("reviewer")) return 30000;
  if (role.includes("builder")) return 40000;
  return 12000;
}
