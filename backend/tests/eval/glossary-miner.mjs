// Turns failed retrieval tickets into plain-language glossary proposals for human review.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { request as devquoteRequest } from "../../src/modules/agent/provider-adapters/devquote-adapter.js";
import { createPersistentSecretBackend } from "../../src/modules/agent/persistent-secret-backend.js";

const DEFAULT_MODEL = "embeddinggemma-tier";
const DEFAULT_TIMEOUT_MS = 60000;

// Resolves explicit CLI/env opt-in so routine retrieval measurements never call an LLM by accident.
export function resolveGlossaryMinerEnabled({ args = {}, env = process.env } = {}) {
  if (Object.prototype.hasOwnProperty.call(args, "no-glossary")) return false;
  if (Object.prototype.hasOwnProperty.call(args, "glossary")) return true;
  return /^(1|true|yes|on)$/i.test(String(env.GLOSSARY_MINER_ENABLED ?? "0"));
}

// Filters eval rows to vocabulary-miss candidates for LLM analysis.
export function selectMissCases(rows, { maxK, semanticThreshold = 1 } = {}) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => Object.entries(row).some(([key, value]) => key.startsWith("recall@") && Number(value) === 0)
    || row[`recall@${maxK}`] === 0
    || (Number.isFinite(Number(row.semantic_score)) && Number(row.semantic_score) < semanticThreshold)
    || Number(row.semantic_matches ?? 0) < semanticThreshold);
}

// Builds the mismatch-analysis prompt from ticket text and ground-truth excerpts.
export function buildMinerPrompt(caseItem, fileSnippets) {
  const files = fileSnippets.map(({ path, excerpt }) => `File: ${path}\n${excerpt}`).join("\n\n---\n\n");
  return `Ticket title: ${caseItem.title}\nObjective: ${caseItem.objective}\nAcceptance: ${(caseItem.acceptance_criteria ?? []).join("; ")}\n\nCorrect files (retrieval missed these):\n${files}\n\nWhich words or phrases in the ticket name a business concept whose code uses a different term (visible in filenames, function names, or symbols above)? Reply ONLY as a JSON array: [{"business_term":"...","suggested_code_term":"...","confidence":0.0-1.0}]. Max 3 items; empty array if none. Prefer generic reusable terms over ticket-specific nouns.`;,
  candidate_files: [{ path: 'backend/src/application/ticket-crud-service.js', role: 'REFERENCE', reason: 'Ticket persistence entry point.' }],
}

// Queries the lightweight chat model once for a single miss case.
export async function queryMinerLlm(prompt, { gatewayUrl, credential, model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS, correlationId, agentExecutor, agentId } = {}) {
  if (typeof agentExecutor === "function") {
    const response = await agentExecutor({
      agentId,
      role: "linguist",
      prompt,
      correlationId,
      // The SDK gateway runs the linguist profile model; only an explicit
      // override is forwarded, never the direct-gateway default.
      options: { ...(model !== DEFAULT_MODEL ? { model } : {}), maxTurns: 1 }
    });
    return response?.text ?? response?.payload?.text ?? "";
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await devquoteRequest({ url: gatewayUrl, credential, payload: { text: prompt, role: "linguist", max_turns: 1 }, model, correlationId, signal: controller.signal });
    return response?.payload?.text ?? "";
  } finally {
    clearTimeout(timeout);
  }
}

// Parses the model reply into suggestion items, returning empty on any failure.
export function parseSuggestions(rawText) {
  try {
    const parsed = JSON.parse(String(rawText).trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.business_term === "string" && item.business_term.trim() && typeof item.suggested_code_term === "string" && item.suggested_code_term.trim())
      .slice(0, 3)
      .map((item) => ({ business_term: item.business_term.trim(), suggested_code_term: item.suggested_code_term.trim(), confidence: Number(item.confidence) || null }));
    // eslint-disable-next-line no-silent-catch -- Non-LLM text is not suggestions; empty array means no proposal.
  } catch {
    return [];
  }
}

// Merges items into the store, bumping seen_count on duplicate business terms.
export function upsertSuggestions(store, items, ticketId, now) {
  let added = 0;
  let deduped = 0;
  for (const item of items) {
    const key = `${item.business_term.toLocaleLowerCase("vi-VN")}\u0000${item.suggested_code_term.toLocaleLowerCase("en-US")}`;
    const existing = store.find((entry) => `${entry.business_term.toLocaleLowerCase("vi-VN")}\u0000${entry.suggested_code_term.toLocaleLowerCase("en-US")}` === key);
    if (existing) {
      existing.seen_count += 1;
      existing.last_seen = now;
      if (!existing.source_ticket_ids.includes(ticketId)) existing.source_ticket_ids.push(ticketId);
      deduped += 1;
    } else {
      store.push({ business_term: item.business_term, suggested_code_term: item.suggested_code_term, confidence: item.confidence, source_ticket_ids: [ticketId], seen_count: 1, first_seen: now, last_seen: now });
      added += 1;
    }
  }
  return { added, deduped };
}

// Renders the suggestion store as a review-ready markdown table.
export function renderSuggestionsMarkdown(store, { runStats } = {}) {
  const lines = [
    "# Glossary Suggestions - pending human review",
    "",
    "Auto-detected by `eval:retrieval:mine` from retrieval miss cases. Do NOT merge automatically — a human reviews each row before adding it to `glossary.md`.",
    "",
    "| Business term | Suggested code term | Confidence | Seen | Sources | First seen | Last seen |",
    "|---|---|---|---|---|---|---|"
  ];
  for (const entry of [...store].sort((a, b) => b.seen_count - a.seen_count || a.business_term.localeCompare(b.business_term))) {
    lines.push(`| ${entry.business_term} | \`${entry.suggested_code_term}\` | ${entry.confidence ?? "-"} | ${entry.seen_count} | ${entry.source_ticket_ids.join(", ")} | ${entry.first_seen} | ${entry.last_seen} |`);
  }
  if (runStats) lines.push("", `Last run: cases=${runStats.cases} misses=${runStats.misses} llm_calls=${runStats.llmCalls} model=${runStats.model} total_ms=${runStats.totalMs} added=${runStats.added} deduped=${runStats.deduped} at=${runStats.at}`);
  return `${lines.join("\n")}\n`;
}

// Runs glossary mining over eval miss cases and persists suggestions.
export async function runGlossaryMining({ rows, cases, root, maxK, semanticThreshold, gatewayUrl, secrets, credential, agentId = "linguist", model = DEFAULT_MODEL, agentExecutor, now = () => new Date().toISOString() } = {}) {
  const startedAt = Date.now();
  const misses = selectMissCases(rows, { maxK, semanticThreshold });
  const stats = { cases: rows.length, misses: misses.length, llmCalls: 0, model, totalMs: 0, added: 0, deduped: 0, at: now() };
  if (misses.length === 0) {
    console.log(`[glossary-miner] cases=${stats.cases} misses=0 nothing to mine`);
    return stats;
  }
  const maxFiles = Number(process.env.GLOSSARY_MAX_FILES ?? 3);
  const maxChars = Number(process.env.GLOSSARY_MAX_FILE_CHARS ?? 4000);
  const storePath = join(root, "vocabulary", "glossary-suggestions.json");
  const markdownPath = join(root, "vocabulary", "glossary-suggestions.md");
  let store = [];
  try {
    store = JSON.parse(readFileSync(storePath, "utf8"));
    if (!Array.isArray(store)) store = [];
    // eslint-disable-next-line no-silent-catch -- Missing store file means first run; empty store is the seed.
  } catch { store = []; }
  const resolvedCredential = credential ?? secrets?.get?.(agentCredentialRef(agentId));
  for (const row of misses) {
    const caseItem = cases.find((item) => item.id === row.id);
    if (!caseItem) continue;
    const snippets = readSnippets(caseItem, root, maxFiles, maxChars);
    if (snippets.length === 0) {
      console.log(`[glossary-miner] skip ${row.id}: no readable ground-truth files`);
      continue;
    }
    try {
      const raw = await queryMinerLlm(buildMinerPrompt(caseItem, snippets), { gatewayUrl, credential: resolvedCredential, model, agentExecutor, agentId, correlationId: `GLOSSARY-MINE-${row.id}` });
      stats.llmCalls += 1;
      const items = parseSuggestions(raw);
      if (items.length === 0) {
        console.log(`[glossary-miner] ${row.id}: no suggestions parsed`);
        continue;
      }
      const result = upsertSuggestions(store, items, row.id, now());
      stats.added += result.added;
      stats.deduped += result.deduped;
    } catch (error) {
      console.log(`[glossary-miner] skip ${row.id}: llm unreachable (${error.message})`);
    }
  }
  stats.totalMs = Date.now() - startedAt;
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
  writeFileSync(markdownPath, renderSuggestionsMarkdown(store, { runStats: stats }));
  console.log(`[glossary-miner] cases=${stats.cases} misses=${stats.misses} llm_calls=${stats.llmCalls} model=${stats.model} total_ms=${stats.totalMs} added=${stats.added} deduped=${stats.deduped}`);
  return stats;
}

// Reads capped excerpts of ground-truth files for the miner prompt.
function readSnippets(caseItem, root, maxFiles, maxChars) {
  const snippets = [];
  for (const path of (caseItem.files_changed ?? caseItem.ground_truth ?? []).map((entry) => typeof entry === "string" ? entry : entry?.path).filter(Boolean).slice(0, maxFiles)) {
    try {
      snippets.push({ path, excerpt: readFileSync(join(root, path), "utf8").slice(0, maxChars) });
    } catch {
      console.log(`[glossary-miner] unreadable file skipped: ${path}`);
    }
  }
  return snippets;
}

// Resolves the secrets-vault credential reference for the miner agent profile.
function agentCredentialRef(agentId) {
  return `runtime:${agentId}:api-key`;
}

// Opens the persistent secrets vault for miner credential lookups.
export function openMinerSecrets({ dataDir, encryptionKey }) {
  return createPersistentSecretBackend({ filePath: join(dataDir, "secrets.vault"), encryptionKey });
}
