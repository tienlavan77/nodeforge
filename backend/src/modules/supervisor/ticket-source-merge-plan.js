// Compares retained ticket edits with concurrent project edits without discarding either author's work.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
// Preserves physical source lines and the final newline while calculating exact replacement intervals.
const lines = (content) => content.match(/[^\n]*\n|[^\n]+$/g) ?? [];

// Extracts zero-context Git edit intervals; adjacent edits remain independent rather than conflicting by context.
async function edits(directory, name, base, content) {
  const path = join(directory, name);
  await writeFile(path, content, { mode: 0o600 });
  let output;
  try { ({ stdout: output } = await exec("git", ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--text", "--unified=0", "--", join(directory, "base"), path], { maxBuffer: 16 * 1024 * 1024 })); }
  catch (error) { if (error.code !== 1) throw error; output = error.stdout; }
  const target = lines(content);
  return [...output.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => {
    const count = Number(match[2] ?? 1), added = Number(match[4] ?? 1);
    const start = Number(match[1]) - (count ? 1 : 0);
    const offset = Number(match[3]) - (added ? 1 : 0);
    return { start, end: start + count, content: target.slice(offset, offset + added).join("") };
  });
}

// Plans a conservative three-way merge; conflicting creation/deletion and overlapping divergent edits require Coder resolution.
export async function planTicketSourceMerge({ base, ticket, live }) {
  if (ticket === live) return { status: "identical", content: live, conflicts: [] };
  if (base === live) return { status: "merged", content: ticket, conflicts: [] };
  if (base === ticket) return { status: "merged", content: live, conflicts: [] };
  if ([base, ticket, live].some((value) => typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 4 * 1024 * 1024))
    return { status: "conflict", conflicts: [{ reason: "creation_deletion_binary_or_large_source" }] };
  const directory = await mkdtemp(join(tmpdir(), "nodeforge-source-merge-"));
  try {
    await writeFile(join(directory, "base"), base, { mode: 0o600 });
    const [owned, concurrent] = await Promise.all([edits(directory, "ticket", base, ticket), edits(directory, "live", base, live)]);
    const conflicts = [];
    const combined = [...owned];
    for (const change of concurrent) {
      if (owned.some((item) => JSON.stringify(item) === JSON.stringify(change))) continue;
      const overlaps = owned.filter((item) => item.start === change.start || item.start < change.end && change.start < item.end
        || item.start === item.end && item.start > change.start && item.start < change.end
        || change.start === change.end && change.start > item.start && change.start < item.end);
      if (overlaps.length) conflicts.push({ base_start_line: change.start + 1, base_end_line: Math.max(change.end, change.start + 1), reason: "overlapping_edits" });
      combined.push(change);
    }
    if (conflicts.length) return { status: "conflict", conflicts };
    const result = lines(base);
    for (const change of combined.sort((a, b) => b.start - a.start)) result.splice(change.start, change.end - change.start, ...lines(change.content));
    return { status: "merged", content: result.join(""), conflicts: [] };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
