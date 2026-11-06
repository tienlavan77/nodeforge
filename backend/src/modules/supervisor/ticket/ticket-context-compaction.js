// Business purpose: preserves Coder file checksums and execution receipts across phase yields, in-memory history compaction, and token-threshold session rollovers so long-running ticket turns never lose before_checksum evidence or burn context tokens on stale tool payloads.
// Technical description: exports activeFileChecksums, formatActiveReceiptDigest, compactFunctionCallingHistory, extractTurnInputTokens, shouldRolloverSdkSession, and buildCompactedRolloverPrompt for the supervisor ticket execution loop.
import { TICKET_WORK_PROGRESS_PROMPT } from "./ticket-work-progress.js";
import { activeFileChecksums } from "./ticket-read-cache.js";
import { formatMidFlightDirectives } from "./ticket-directive-inbox.js";

export const DEFAULT_ROLLOVER_INPUT_TOKENS = 230000;
const STUB_CHAR_THRESHOLD = 1200;

export { activeFileChecksums };

// Business purpose: summarizes active file checksums, changed paths, and recent turn outcomes into a compact receipt digest that fits safely inside continuation and rollover prompts.
// Technical description: combines deduplicated path->sha256 entries from readCache with changedPaths, receipt_position, and the last 8 turnHistory entries, bounding the serialized digest to 2000 characters.
export function formatActiveReceiptDigest(state = {}) {
  const checksums = activeFileChecksums(state.readCache);
  const digest = {
    receipt_position: state.sdkTurnProgress?.receipt_position ?? state.turnCount ?? 0,
    last_completed_turn: state.turnCount ?? 0,
    changed_paths: Array.isArray(state.changedPaths) ? [...new Set(state.changedPaths)] : [],
    active_file_checksums: checksums,
    recent_turns: Array.isArray(state.turnHistory) ? state.turnHistory.slice(-8) : []
  };
  const serialized = JSON.stringify(digest);
  if (serialized.length <= 2000) return serialized;
  return JSON.stringify({
    receipt_position: digest.receipt_position,
    last_completed_turn: digest.last_completed_turn,
    changed_paths: digest.changed_paths.slice(-12),
    active_file_checksums: Object.fromEntries(Object.entries(checksums).slice(-16)),
    recent_turns: digest.recent_turns.slice(-4)
  }).slice(0, 2000);
}

// Business purpose: reduces in-memory function-calling conversation history between phases so compatible-provider Coder runs do not accumulate megabytes of obsolete file reads and search outputs.
// Technical description: retains the initial assignment item and the most recent preserveRecentItems entries, replacing oversized intermediate tool outputs (>1200 chars) or invalidated file reads with compact structured receipt stubs.
export function compactFunctionCallingHistory(history, { readCache = {}, changedPaths = [], maxHistoryBytes = 65536, preserveRecentItems = 6 } = {}) {
  if (!Array.isArray(history) || history.length <= preserveRecentItems + 1) {
    const bytes = Array.isArray(history) ? Buffer.byteLength(JSON.stringify(history)) : 0;
    return { history, compacted: false, beforeBytes: bytes, afterBytes: bytes, compactedItems: 0 };
  }
  const beforeBytes = Buffer.byteLength(JSON.stringify(history));
  const checksums = activeFileChecksums(readCache);
  const changedSet = new Set(Array.isArray(changedPaths) ? changedPaths : []);
  const cutoff = Math.max(1, history.length - Math.max(1, preserveRecentItems));
  let hasStaleMutatedRead = false;
  for (let i = 1; i < cutoff; i += 1) {
    const meta = inspectHistoryToolItem(history[i]);
    if (meta && meta.path && changedSet.has(meta.path)) { hasStaleMutatedRead = true; break; }
  }
  if (beforeBytes <= maxHistoryBytes && !hasStaleMutatedRead) {
    return { history, compacted: false, beforeBytes, afterBytes: beforeBytes, compactedItems: 0 };
  }
  let compactedItems = 0;
  const compactedHistory = history.map((item, index) => {
    if (index === 0 || index >= cutoff || !item || typeof item !== "object") return item;
    const replaced = compactHistoryItem(item, checksums, changedSet);
    if (replaced !== item) compactedItems += 1;
    return replaced;
  });
  const afterBytes = Buffer.byteLength(JSON.stringify(compactedHistory));
  return {
    history: compactedItems > 0 ? compactedHistory : history,
    compacted: compactedItems > 0,
    beforeBytes,
    afterBytes: compactedItems > 0 ? afterBytes : beforeBytes,
    compactedItems
  };
}

// Business purpose: identifies whether an intermediate history entry represents a verbose tool output or a superseded file read that can be replaced by a receipt stub.
// Technical description: inspects function_call_output and tool-role items to extract the tool name, target path, and serialized payload length without mutating the original object.
function inspectHistoryToolItem(item) {
  if (!item || typeof item !== "object") return null;
  const isToolItem = item.type === "function_call_output" || item.role === "tool" || item.type === "tool_result" || item.output !== undefined;
  if (!isToolItem) return null;
  const field = item.output !== undefined ? "output" : item.content !== undefined ? "content" : null;
  if (!field) return null;
  const raw = item[field];
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  let parsed = typeof raw === "object" && raw !== null ? raw : null;
  if (!parsed && typeof raw === "string" && raw.trim().startsWith("{")) {
    // eslint-disable-next-line no-silent-catch -- Non-JSON tool output strings remain plain text for length checking.
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
  }
  const path = typeof (parsed?.path ?? parsed?.file_path ?? item.path ?? item.file_path) === "string"
    ? (parsed?.path ?? parsed?.file_path ?? item.path ?? item.file_path)
    : null;
  const tool = typeof item.name === "string" ? item.name : typeof item.tool === "string" ? item.tool : parsed?.code_index ? "read_file" : parsed?.file_path ? "Read" : parsed?.stdout !== undefined ? "search_text" : "tool";
  return { field, raw, text, parsed, path, tool };
}

// Business purpose: replaces a single oversized or stale tool output item with a compact receipt stub while preserving the item's envelope shape for the provider SDK.
// Technical description: substitutes strings or objects exceeding STUB_CHAR_THRESHOLD (or referencing a mutated file) with a JSON receipt containing path, latest sha256, and total_lines.
function compactHistoryItem(item, checksums, changedSet) {
  const info = inspectHistoryToolItem(item);
  if (!info) return item;
  if (info.parsed?.compacted_receipt === true) return item;
  const isStaleRead = Boolean(info.path && changedSet.has(info.path) && info.text.length > 256);
  if (info.text.length <= STUB_CHAR_THRESHOLD && !isStaleRead) return item;
  const latestChecksum = info.path && checksums[info.path] ? checksums[info.path] : null;
  const stub = {
    compacted_receipt: true,
    tool: info.tool,
    ...(info.path ? { path: info.path } : {}),
    ...(latestChecksum?.sha256 ?? info.parsed?.sha256 ? { sha256: latestChecksum?.sha256 ?? info.parsed?.sha256 } : {}),
    ...(Number.isInteger(latestChecksum?.total_lines ?? info.parsed?.total_lines) ? { total_lines: latestChecksum?.total_lines ?? info.parsed?.total_lines } : {}),
    status: "retained_in_active_checksum_digest"
  };
  return {
    ...item,
    [info.field]: typeof info.raw === "string" ? JSON.stringify(stub) : stub
  };
}

// Business purpose: measures the prompt context footprint of a single model invocation so session rollover decisions evaluate actual context window occupancy without double-counting cached tokens.
// Technical description: adds cache_creation_input_tokens and disjoint Anthropic cache_read_input_tokens to input_tokens, while treating OpenAI/Codex cached_input_tokens / cached_tokens as a subset of input_tokens via Math.max.
export function measureSingleCallInputTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  const rawBase = Number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens ?? 0);
  const base = Number.isFinite(rawBase) && rawBase > 0 ? rawBase : 0;
  const rawCreate = Number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0);
  const cacheCreate = Number.isFinite(rawCreate) && rawCreate > 0 ? rawCreate : 0;
  const rawDisjointRead = usage.cache_read_input_tokens ?? usage.cacheReadInputTokens;
  if (rawDisjointRead !== undefined && rawDisjointRead !== null) {
    const cacheRead = Number(rawDisjointRead);
    return base + cacheCreate + (Number.isFinite(cacheRead) && cacheRead > 0 ? cacheRead : 0);
  }
  const rawInclusiveCached = Number(
    usage.cached_input_tokens ?? usage.cachedInputTokens ?? usage.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens ?? usage.inputTokensDetails?.cachedTokens
    ?? usage.prompt_tokens_details?.cached_tokens ?? 0
  );
  const inclusiveCached = Number.isFinite(rawInclusiveCached) && rawInclusiveCached > 0 ? rawInclusiveCached : 0;
  return Math.max(base, inclusiveCached) + cacheCreate;
}

// Business purpose: counts the number of distinct model invocation rounds in a streamed item list so parallel tool calls within the same round do not artificially deflate context window estimates.
// Technical description: groups contiguous non-message/non-reasoning tool items into a single tool round and returns toolRounds + 1 when tool rounds occurred.
export function estimateItemModelRounds(items) {
  if (!Array.isArray(items) || !items.length) return 1;
  let toolRounds = 0;
  let inToolBatch = false;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "agent_message" || item.type === "reasoning") {
      inToolBatch = false;
    } else if (!inToolBatch) {
      toolRounds += 1;
      inToolBatch = true;
    }
  }
  return toolRounds > 0 ? toolRounds + 1 : 1;
}

// Business purpose: measures the active context window size at the end of an SDK turn so the supervisor knows when a provider session is approaching context limits without being misled by multi-step cumulative tool-loop totals.
// Technical description: prefers explicit final-call context_input_tokens or last_call_usage, normalizes multi-request cumulative usage by rounds/requests or grouped tool-call rounds, and falls back to measureSingleCallInputTokens.
export function extractTurnInputTokens(result) {
  if (!result || typeof result !== "object") return 0;
  const usage = result.usage ?? result.payload?.usage ?? (
    ("input_tokens" in result || "inputTokens" in result || "cache_read_input_tokens" in result || "cached_input_tokens" in result || "cached_tokens" in result || "context_input_tokens" in result)
      ? result
      : null
  );
  const directContext = Number(result.context_input_tokens ?? result.contextInputTokens ?? usage?.context_input_tokens ?? usage?.contextInputTokens);
  if (Number.isFinite(directContext) && directContext > 0) return directContext;
  const lastCallUsage = result.last_call_usage ?? usage?.last_call_usage ?? result.rawResponses?.at?.(-1)?.usage;
  if (lastCallUsage && typeof lastCallUsage === "object") return measureSingleCallInputTokens(lastCallUsage);
  if (!usage || typeof usage !== "object") return 0;
  const singleFootprint = measureSingleCallInputTokens(usage);
  const rounds = Number(usage.rounds ?? usage.requests ?? result.rounds ?? result.requests ?? 0);
  if (Number.isFinite(rounds) && rounds > 1) return Math.round(singleFootprint / rounds);
  const itemRounds = estimateItemModelRounds(result.items);
  if (itemRounds > 1) return Math.round(singleFootprint / itemRounds);
  return singleFootprint;
}

// Business purpose: decides whether an active Claude, Codex, or function-calling Coder session should roll over to a fresh session at a clean phase boundary to prevent context bloat and cost spikes.
// Technical description: returns true when a valid work_progress payload was accepted, an active sessionId/threadId or function-calling history/turn state exists, and turn input tokens meet or exceed the configured threshold.
export function shouldRolloverSdkSession({ result, progress, resumeState, threshold = DEFAULT_ROLLOVER_INPUT_TOKENS } = {}) {
  if (!progress || !resumeState) return false;
  const activeSession = resumeState.sessionId ?? resumeState.threadId;
  const hasSession = typeof activeSession === "string" && Boolean(activeSession.trim());
  const hasHistory = Array.isArray(result?.history) ? result.history.length > 0 : Boolean(result?.turn_completed && (resumeState.turnCount > 0 || resumeState.sdkTurnProgress));
  if (!hasSession && !hasHistory) return false;
  const effectiveThreshold = Number.isInteger(threshold) && threshold > 0 ? threshold : DEFAULT_ROLLOVER_INPUT_TOKENS;
  return extractTurnInputTokens(result) >= effectiveThreshold;
}

// Business purpose: constructs the self-contained handoff prompt for a newly rolled-over SDK session so the Coder continues seamlessly without re-reading unchanged files or losing mid-flight directives.
// Technical description: combines the original ticket assignment basePrompt with the accepted work_progress payload, active file checksums, compact receipt digest, compact turn history, delivered directives, and the work_progress schema contract.
export function buildCompactedRolloverPrompt({ basePrompt, progress, resumeState, directives = [] } = {}) {
  const checksums = activeFileChecksums(resumeState?.readCache);
  const receiptDigest = formatActiveReceiptDigest(resumeState);
  const directiveBlock = formatMidFlightDirectives(
    directives.length ? directives : (resumeState?.deliveredDirectives ?? [])
  );
  const rolledOverFrom = resumeState?.sdkTurnProgress?.rolled_over_from || "in_memory_history";
  const turns = Array.isArray(resumeState?.turnHistory) && resumeState.turnHistory.length
    ? resumeState.turnHistory.map((entry) => `- turn ${entry.turn} ${entry.tool} ${entry.target} -> ${entry.outcome}`.trim()).join("\n")
    : `- Completed tools: ${JSON.stringify((resumeState?.completedTools ?? []).slice(-8))}`;
  return [
    basePrompt ?? "",
    "",
    "=== COMPACTED SESSION HANDOFF (Session rolled over at phase boundary to preserve context budget) ===",
    `Accepted phase progress: ${JSON.stringify(progress?.payload ?? {})}.`,
    `Continue at tool turn ${resumeState?.turnCount ?? 0}. Rolled over from session: ${rolledOverFrom}.`,
    `Compact receipt digest: ${receiptDigest}.`,
    `Active file checksums (reuse as before_checksum for edit_diff/write_diff/delete_file/move_file without re-reading unchanged windows): ${JSON.stringify(checksums)}.`,
    `Files already changed in the worktree: ${JSON.stringify(resumeState?.changedPaths ?? [])}.`,
    "Completed turn receipts (do NOT repeat completed mutations or re-read unchanged windows):",
    turns,
    ...(directiveBlock ? [directiveBlock] : []),
    "Execute the next authorized step now; preserve all existing changes, decisions, and tool receipts.",
    TICKET_WORK_PROGRESS_PROMPT
  ].filter(Boolean).join("\n");
}
