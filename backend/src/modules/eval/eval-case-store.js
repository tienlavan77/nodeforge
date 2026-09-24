// Converts completed-ticket final reports into retrieval-eval cases and appends new tickets automatically.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";

export const REPORTS_DIR = ".forge/runtime/reports";
export const AUTO_EVAL_FILE = "backend/tests/eval/retrieval-cases-auto.js";
const TOOL_LAB_MARKER = "backend/tool-lab-target.txt";
const AUTO_FILE_HEADER = "// Retrieval eval cases auto-backfilled from historical final reports - generated file, do not edit by hand.\n// Regenerate with: node backend/scripts/backfill-eval-cases.mjs (repo root is resolved from the script location).\n";

// Accepts only real Forge ticket ids so lab runs and smoke probes never enter the eval pool.
export function isEvalTicketId(id) {
  return typeof id === "string" && id.startsWith("TICKET-");
}

// Keeps only plausible repo file paths, dropping markers, empty entries, and prose.
export function isRealChangedPath(path) {
  if (typeof path !== "string") return false;
  const trimmed = path.trim();
  if (!trimmed || trimmed === "None" || trimmed === TOOL_LAB_MARKER) return false;
  if (!trimmed.includes("/") || trimmed.includes(" ") || trimmed.includes("\\")) return false;
  if (trimmed.startsWith("/") || trimmed.split("/").some((part) => !part || part === "." || part === "..")) return false;
  const base = trimmed.split("/").pop();
  return Boolean(base && base.includes("."));
}

// Parses one final-report markdown file into ticket text plus filtered file lists.
export function parseFinalReport({ ticketId, markdown }) {
  if (typeof ticketId !== "string" || !ticketId || typeof markdown !== "string" || !markdown) return null;
  const text = markdown.replace(/\r\n/g, "\n");
  const status = text.match(/^-\s*Status:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const heading = text.match(/^#\s*(.+)$/m)?.[1]?.trim() ?? "";
  const title = heading.includes(": ") ? heading.slice(heading.indexOf(": ") + 2).trim() : heading;
  const objective = readSection(text, "## Objective");
  const filesChanged = readSection(text, "## Files Changed").split("\n").map((line) => line.replace(/^-\s*/, "").trim()).filter((line) => line && line !== "None");
  const acceptance_criteria = readSection(text, "## Acceptance Criteria").split("\n")
    .map((line) => line.replace(/^-\s*\[[ x]\]\s*/, "").replace(/^-\s*/, "").replace(/\s+\(not measured by Node\)$/, "").trim())
    .filter(Boolean);
  const realFiles = filesChanged.filter(isRealChangedPath);
  return { ticketId, title, status, objective, filesChanged, realFiles, acceptance_criteria };
}

// Infers the retrieval style filter from ground-truth path prefixes.
export function inferStyle(paths) {
  let frontend = false;
  let backend = false;
  for (const path of paths ?? []) {
    if (path.startsWith("ui/") || path.startsWith("web/src/")) frontend = true;
    if (path.startsWith("backend/") || path.startsWith("schemas/")) backend = true;
  }
  const style = [...(frontend ? ["frontend"] : []), ...(backend ? ["backend"] : [])];
  return style.length ? style : undefined;
}

// Builds one eval case from parsed report content, keeping the curated baseline shape.
export function buildEvalCase({ ticketId, parsed }) {
  const style = inferStyle(parsed.realFiles);
  return {
    id: ticketId,
    note: `Backfilled from final report ${ticketId}.md (status=${parsed.status ?? "unknown"})`,
    title: parsed.title,
    objective: parsed.objective,
    acceptance_criteria: parsed.acceptance_criteria,
    ...(style ? { style } : {}),
    ground_truth: [...parsed.realFiles],
    files_changed: [...parsed.realFiles]
  };
}

// Collects auto cases from every usable historical report on disk.
export function collectAutoCases({ root, ticketFilter = null, limit = 0, exists = null } = {}) {
  const reportsPath = join(root, REPORTS_DIR);
  const files = readdirSync(reportsPath).filter((file) => file.endsWith(".md")).sort();
  const cases = [];
  const stats = { scanned: 0, backfilled: 0, skipped: 0, missingFiles: [] };
  for (const file of files) {
    const ticketId = file.slice(0, -3);
    if (!isEvalTicketId(ticketId)) continue;
    if (ticketFilter && ticketId !== ticketFilter) continue;
    if (limit > 0 && cases.length >= limit) break;
    stats.scanned += 1;
    const parsed = parseFinalReport({ ticketId, markdown: readFileSync(join(reportsPath, file), "utf8") });
    if (parsed?.status !== "completed") {
      stats.skipped += 1;
      continue;
    }
    if (!parsed.realFiles.length) {
      stats.skipped += 1;
      continue;
    }
    const checker = exists ?? (() => true);
    for (const path of parsed.realFiles) {
      if (!checker(join(root, path))) stats.missingFiles.push(`${ticketId} :: ${path}`);
    }
    cases.push(buildEvalCase({ ticketId, parsed }));
    stats.backfilled += 1;
  }
  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { cases, stats };
}

// Renders the generated auto-cases file content from a case list.
export function renderAutoFile(cases) {
  return `${AUTO_FILE_HEADER}export const RETRIEVAL_EVAL_CASES_AUTO = ${JSON.stringify(cases, null, 2)};\n`;
}

// Reads the ticket ids already present in the generated auto-cases file.
export function loadAutoCaseIds({ root }) {
  try {
    const text = readFileSync(join(root, AUTO_EVAL_FILE), "utf8");
    return new Set([...text.matchAll(/^\s*"id":\s*"([^"]+)"/gm)].map((match) => match[1]));
  // eslint-disable-next-line no-silent-catch -- Generated auto file may not exist before the first append.
  } catch {
    return new Set();
  }
}

// Appends one case to the generated file, skipping duplicates by ticket id.
export function appendAutoCase({ root, caseItem }) {
  if (!caseItem?.id) throw new ConfigurationError("Eval case append requires a ticket id.");
  const path = join(root, AUTO_EVAL_FILE);
  mkdirSync(dirname(path), { recursive: true });
  let text = null;
  try {
    text = readFileSync(path, "utf8");
  // eslint-disable-next-line no-silent-catch -- Generated auto file may not exist before the first append.
  } catch {
    text = null;
  }
  if (text && text.includes(`"id": "${caseItem.id}"`)) return false;
  if (!text) {
    writeFileSync(path, renderAutoFile([caseItem]));
    return true;
  }
  const closing = text.lastIndexOf("];");
  if (closing < 0) throw new ConfigurationError("Eval auto-cases file has an unexpected shape; regenerate it with backfill-eval-cases.mjs.");
  const prefix = text.slice(0, closing).trimEnd();
  const entry = JSON.stringify(caseItem, null, 2);
  writeFileSync(path, `${prefix}${prefix.endsWith("[") ? "" : ","}\n${entry}\n];\n`);
  return true;
}

// Rewrites the generated auto-cases file from a case list.
export function writeAutoFile({ root, cases }) {
  const path = join(root, AUTO_EVAL_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderAutoFile(cases));
  return { path, count: cases.length };
}

// Records a just-completed ticket into the auto eval pool without ever failing report_done.
export function createEvalCaseRecorder({ root } = {}) {
  if (typeof root !== "string" || !root) throw new ConfigurationError("Eval case recorder requires root.");
  return async function recordEvalCase({ ticket, report } = {}) {
    const id = ticket?.id;
    if (!isEvalTicketId(id)) return { appended: false, reason: "non-ticket-id" };
    if (report?.status !== "completed") return { appended: false, reason: `status=${report?.status ?? "unknown"}` };
    const files = (Array.isArray(report?.files_changed) ? report.files_changed : [])
      .map((entry) => (typeof entry === "string" ? entry : entry?.path))
      .filter(isRealChangedPath);
    if (!files.length) return { appended: false, reason: "empty-files-changed" };
    if (loadAutoCaseIds({ root }).has(id)) return { appended: false, reason: "duplicate" };
    const caseItem = buildEvalCase({
      ticketId: id,
      parsed: {
        title: ticket.title ?? report?.ticket?.title ?? id,
        status: report.status,
        objective: ticket.objective ?? report?.ticket?.objective ?? "",
        acceptance_criteria: ticket.acceptance_criteria ?? [],
        realFiles: files
      }
    });
    appendAutoCase({ root, caseItem });
    console.log(`[eval-append] appended ${id} (${files.length} files)`);
    return { appended: true };
  };
}

// Reads one markdown section body up to the next section heading.
function readSection(text, heading) {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length);
  const end = rest.search(/^##\s/m);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}
