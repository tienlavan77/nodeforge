// Business purpose: synchronizes Compact Receipt digests, active file checksums, Discovery Compact Receipts, and token-threshold session rollovers for System Engineer (SE) and Architecture Manager (AM) conversations so owner-driven engineering and 3-phase planning preserve exact file evidence without context bloat.
// Technical description: extracts file paths, sha256 checksums, and line counts from read/write tool calls, maintains active_file_checksums maps, builds bounded owner and discovery receipt digests, and evaluates token-threshold rollover for owner SDK sessions.
import { DEFAULT_ROLLOVER_INPUT_TOKENS, extractTurnInputTokens } from "../modules/supervisor/ticket/ticket-context-compaction.js";

const READ_TOOLS = new Set(["read_file", "read_file_binary", "Read", "sed_lines"]);
const WRITE_TOOLS = new Set(["write_diff", "edit_diff", "delete_file", "move_file"]);
const DISCOVERY_TOOLS = new Set(["read_file", "read_file_binary", "Read", "search_text", "list_files", "search_tree"]);

// Business purpose: normalizes file path metadata across read_file, Read, edit_diff, write_diff, delete_file, and move_file calls so SE and AM checkpoints track every accessed or modified file consistently.
// Technical description: extracts path, from_path, to_path, symbol, start_line, and end_line from a tool input object.
export function extractOwnerToolPathMeta(name, input) {
  if (!input || typeof input !== "object") return {};
  if (name === "move_file") {
    return {
      ...(typeof input.from_path === "string" && input.from_path ? { from_path: input.from_path } : {}),
      ...(typeof input.to_path === "string" && input.to_path ? { to_path: input.to_path, path: input.to_path } : {})
    };
  }
  const path = typeof (input.path ?? input.file_path) === "string" ? (input.path ?? input.file_path) : "";
  return {
    ...(path ? { path } : {}),
    ...(typeof input.file_path === "string" && input.file_path ? { file_path: input.file_path } : {}),
    ...(typeof input.symbol === "string" && input.symbol ? { symbol: input.symbol } : {}),
    ...(Number.isInteger(input.start_line ?? input.offset) ? { start_line: input.start_line ?? input.offset } : {}),
    ...(Number.isInteger(input.end_line ?? input.limit) ? { end_line: input.end_line ?? input.limit } : {})
  };
}

// Business purpose: extracts the verified sha256 checksum and line count from a completed Forge read or write tool result so SE and AM can chain subsequent edits without re-reading unchanged files.
// Technical description: inspects result.sha256, result.after_checksum, or embedded text receipts for a sha256 digest and captures total_lines when present.
export function extractOwnerResultChecksum(step, result) {
  if (!result || typeof result !== "object") return { sha256: null, totalLines: null };
  const textReceipt = result.content?.find?.((item) => item?.type === "text")?.text ?? "";
  const matched = /\((sha256:[a-fA-F0-9]{64})\)/.exec(textReceipt)?.[1] ?? null;
  const rawSha = typeof result.sha256 === "string" ? result.sha256
    : typeof result.after_checksum === "string" ? result.after_checksum
      : matched;
  const sha256 = typeof rawSha === "string" && /^sha256:[a-fA-F0-9]{64}$/.test(rawSha) ? rawSha : null;
  const totalLines = Number.isInteger(result.total_lines) ? result.total_lines : null;
  return { sha256, totalLines };
}

// Business purpose: updates the active_file_checksums map after a read or mutation tool call so checkpoints and conversation state always reflect the latest file sha256.
// Technical description: removes deleted or moved-from paths and records sha256, total_lines, and read/mutated status for the target path.
export function updateActiveFileChecksums(currentMap = {}, { toolName, step, result } = {}) {
  const next = { ...(currentMap && typeof currentMap === "object" ? currentMap : {}) };
  const name = toolName ?? step?.tool_name;
  if (name === "delete_file") {
    if (step?.path) delete next[step.path];
    return next;
  }
  if (name === "move_file" && step?.from_path) {
    delete next[step.from_path];
  }
  const targetPath = step?.to_path ?? step?.path ?? result?.path ?? result?.file_path;
  const { sha256, totalLines } = extractOwnerResultChecksum(step, result);
  if (typeof targetPath === "string" && targetPath && sha256) {
    const previousLines = Number.isInteger(next[targetPath]?.total_lines) ? next[targetPath].total_lines : null;
    next[targetPath] = {
      sha256,
      ...(Number.isInteger(totalLines ?? previousLines) ? { total_lines: totalLines ?? previousLines } : {}),
      status: WRITE_TOOLS.has(name) ? `mutated:${name}` : READ_TOOLS.has(name) ? "read" : "observed"
    };
  }
  return next;
}

// Business purpose: builds a compact, bounded JSON digest of active file checksums and recent tool steps for SE and AM Continue, Restart, and session rollover prompts.
// Technical description: combines lineage/step metadata, active_file_checksums, changed_paths, and recent completed steps into a serialized JSON digest capped at 2400 chars.
export function formatOwnerCompactReceiptDigest({ checkpoint, state, selectedReceipts = [] } = {}) {
  const checksums = {
    ...(state?.active_file_checksums && typeof state.active_file_checksums === "object" ? state.active_file_checksums : {}),
    ...(checkpoint?.active_file_checksums && typeof checkpoint.active_file_checksums === "object" ? checkpoint.active_file_checksums : {})
  };
  const changedPaths = [...new Set([...(state?.owner_changed_paths ?? []), ...(checkpoint?.changed_paths ?? [])])].slice(-20);
  const steps = selectedReceipts.map(({ sequence, tool_name, path, file_path, after_checksum, read_checksum, total_lines, commit_sha }) => ({
    sequence,
    tool_name,
    ...(path ?? file_path ? { path: path ?? file_path } : {}),
    ...(after_checksum ? { after_checksum } : {}),
    ...(read_checksum ? { read_checksum } : {}),
    ...(Number.isInteger(total_lines) ? { total_lines } : {}),
    ...(commit_sha ? { commit_sha } : {})
  }));
  const digest = {
    ...(checkpoint ? {
      lineage_id: checkpoint.lineage_id,
      attempt_number: checkpoint.attempt_number,
      resume_of: checkpoint.resume_of,
      last_completed_step: checkpoint.last_completed_step,
      pending_steps: (checkpoint.pending_tool_calls ?? []).map(({ sequence, tool_name }) => ({ sequence, tool_name })),
      receipts_truncated: checkpoint.receipts_truncated
    } : {}),
    changed_paths: changedPaths,
    active_file_checksums: checksums,
    completed_steps: steps
  };
  return JSON.stringify(digest);
}

// Business purpose: records repository discovery steps (read_file, Read, search_text, list_files, search_tree) during AM clarification discovery so Phase 2 (Plan Generation) and Phase 3 (Plan Update) inherit verified file paths, checksums, and line windows without redundant tool calls.
// Technical description: appends a compact discovery receipt entry and updates active_file_checksums on the conversation state object.
export function recordDiscoveryCompactStep(state = {}, { toolName, input, result } = {}) {
  if (!DISCOVERY_TOOLS.has(toolName)) return null;
  const meta = extractOwnerToolPathMeta(toolName, input);
  const targetPath = meta.path ?? result?.path ?? result?.file_path ?? null;
  const { sha256, totalLines } = extractOwnerResultChecksum({ tool_name: toolName, ...meta }, result);
  const activeChecksums = updateActiveFileChecksums(state.active_file_checksums, {
    toolName,
    step: { tool_name: toolName, path: targetPath },
    result
  });
  const range = meta.symbol ? `#${meta.symbol}`
    : Number.isInteger(meta.start_line) || Number.isInteger(meta.end_line) ? `L${meta.start_line ?? 1}-L${meta.end_line ?? totalLines ?? ""}`
      : Number.isInteger(totalLines) ? `L1-L${totalLines}` : null;
  const entry = {
    tool: toolName,
    ...(targetPath ? { path: targetPath } : {}),
    ...(sha256 ? { sha256 } : {}),
    ...(Number.isInteger(totalLines) ? { total_lines: totalLines } : {}),
    ...(range ? { location: range } : {}),
    ...(toolName === "search_text" && typeof input?.pattern === "string" ? { pattern: input.pattern.slice(0, 80) } : {})
  };
  const existing = Array.isArray(state.discovery_receipts) ? state.discovery_receipts : [];
  const deduplicated = existing.filter((item) => !(item.tool === entry.tool && item.path && item.path === entry.path && item.location === entry.location));
  return {
    active_file_checksums: activeChecksums,
    discovery_receipts: [...deduplicated, entry].slice(-32)
  };
}

// Business purpose: formats the accumulated Discovery Compact Receipt from Phase 1 so Phase 2 (generationPrompt) and Phase 3 (updatePrompt) can cite inspected files and line ranges directly.
// Technical description: serializes inspected file checksums, line counts, and discovery steps into a concise prompt block.
export function formatDiscoveryCompactReceipt(state = {}) {
  const checksums = state?.active_file_checksums && typeof state.active_file_checksums === "object" ? state.active_file_checksums : {};
  const receipts = Array.isArray(state?.discovery_receipts) ? state.discovery_receipts : [];
  if (!Object.keys(checksums).length && !receipts.length) return "";
  const payload = {
    active_file_checksums: checksums,
    inspected_steps: receipts.slice(-24)
  };
  return `\n\nDiscovery Compact Receipt (from prior repository inspection in this conversation — reuse these verified paths, sha256 checksums, total_lines, and line ranges directly as evidence without re-reading unchanged files):\n${JSON.stringify(payload)}`;
}

// Business purpose: determines whether an active SE or AM SDK thread has exceeded the input token threshold and should roll over to a fresh session on the next turn.
// Technical description: checks retainedState.sdk_thread_id and compares retainedState.last_turn_input_tokens against threshold (default 120,000).
export function shouldRolloverOwnerSession(retainedState = {}, { continueExecution = false, resumeOf = null, planningInputOnly = false, threshold = DEFAULT_ROLLOVER_INPUT_TOKENS } = {}) {
  if (continueExecution || resumeOf || planningInputOnly) return false;
  const hasThread = typeof retainedState?.sdk_thread_id === "string" && Boolean(retainedState.sdk_thread_id.trim());
  const hasHistory = Array.isArray(retainedState?.sdk_history) && retainedState.sdk_history.length > 0;
  if (!hasThread && !hasHistory) return false;
  const effectiveThreshold = Number.isInteger(threshold) && threshold > 0 ? threshold : DEFAULT_ROLLOVER_INPUT_TOKENS;
  const lastTokens = Number(retainedState.last_turn_input_tokens ?? extractTurnInputTokens(retainedState) ?? 0);
  return Number.isFinite(lastTokens) && lastTokens >= effectiveThreshold;
}

// Business purpose: formats conversation history for Owner SDK prompts while preserving complete turn boundaries and role prefixes so prompt truncation never cuts mid-sentence or strips User/Assistant labels.
// Technical description: selects recent turns from the end of the history array within maxChars, truncating oversized individual turn bodies with a clean ellipsis while retaining their role prefix.
export function formatTurnBoundaryHistory(turns = [], { maxChars = 8000, maxTurnChars = 3600 } = {}) {
  if (!Array.isArray(turns) || !turns.length) return "";
  const formatted = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    const role = turn?.role === "Assistant" ? "Assistant" : "User";
    const rawText = String(turn?.text ?? "").trim();
    if (!rawText) continue;
    const boundedText = rawText.length > maxTurnChars ? `${rawText.slice(0, maxTurnChars)}...[turn truncated]` : rawText;
    const line = `${role}: ${boundedText}`;
    if (formatted.length > 0 && total + line.length + 1 > maxChars) break;
    formatted.unshift(line);
    total += line.length + 1;
  }
  return formatted.join("\n");
}

// Business purpose: constructs a clean Structured Work Handoff block when an Owner SDK session rolls over at the token threshold so the new session inherits verified objectives, active agent identity, and tool receipts without carrying over raw assistant prose from prior turns.
// Technical description: combines active profile identity (role, provider, agent_id), prior User objectives extracted from history, and the serialized Compact Receipt Digest.
export function formatOwnerStructuredWorkHandoff({ profile, history = [], checkpoint, state, selectedReceipts = [], compactDigest } = {}) {
  const digest = compactDigest || formatOwnerCompactReceiptDigest({ checkpoint, state, selectedReceipts });
  const userObjectives = (Array.isArray(history) ? history : [])
    .filter((turn) => turn?.role === "User" && typeof turn.text === "string" && turn.text.trim())
    .slice(-3)
    .map((turn) => turn.text.trim().slice(0, 400));
  const handoff = {
    handoff_type: "structured_work_handoff",
    active_agent: {
      agent_id: profile?.agent_id ?? null,
      role: profile?.role ?? null,
      provider: profile?.provider ?? null
    },
    prior_user_objectives: userObjectives
  };
  return `\nSession rolled over at token threshold (${state?.last_turn_input_tokens ?? 0} tokens). Structured Work Handoff: ${JSON.stringify(handoff)}. Compact Receipt Digest (reuse active_file_checksums as before_checksum without re-reading unchanged files): ${digest}\n`;
}

export { DEFAULT_ROLLOVER_INPUT_TOKENS, extractTurnInputTokens };
