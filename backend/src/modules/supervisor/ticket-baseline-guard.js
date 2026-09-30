// Verifies the owner-approved A5 source identity before a Coder can run on the project root.
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { isDeepStrictEqual } from "node:util";
import { ConfigurationError } from "../../shared/errors.js";

const execFile = promisify(execFileCallback);
// Attaches a stable code to baseline failures for the Supervisor checkpoint.
const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });
// Hashes approved source bytes and canonical manifest lines.
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Reads Git identity without changing the checkout or consuming agent tool permissions.
async function git(root, ...args) {
  const { stdout } = await execFile("git", args, { cwd: root, timeout: 10000 });
  return stdout.trim();
}

// Rejects source, contract, or approval drift before the immutable context is created.
export async function verifyTicketBaseline({ workspace, taskId, supervisorId, ticket, existing }) {
  if (!workspace?.root_only || !workspace?.fileService?.readFile || !ticket?.execution_contract) throw fail("TICKET_BASELINE_REQUIRED", "A5-R2 requires root-only execution and a persisted ticket contract.");
  const root = workspace.projectRoot;
  let receipt;
  try { receipt = JSON.parse(await workspace.fileService.readFile({ path: `.forge/runtime/ticket-baselines/${taskId}.json` })); }
  catch (error) { throw fail("TICKET_BASELINE_REQUIRED", `Approved A5-R2 baseline is unavailable: ${error.code ?? error.message}.`); }
  if (receipt.status !== "approved" || receipt.ticket_id !== taskId || receipt.project_id !== ticket.project_id || receipt.execution_root !== root || receipt.approved_by !== receipt.contract?.human_authority || receipt.contract?.supervisor !== supervisorId || !isDeepStrictEqual(receipt.contract, ticket.execution_contract) || !isDeepStrictEqual(receipt.verification_plan, receipt.contract.verification_plan)) throw fail("TICKET_BASELINE_CONTRACT", "A5-R2 approval or ticket contract does not match the durable receipt.");
  if (ticket.provenance?.source_id === "NF-PIPE-ERR-005-A5-R2") {
    const previous = receipt.previous_run;
    if (previous?.task_id !== ticket.provenance.source_id || previous?.status !== "blocked" || previous?.context_version !== 2 || previous?.ledger_revision !== 2) throw fail("TICKET_BASELINE_PREVIOUS_RUN", "A5 retry must identify the blocked prior RUN.");
    const disposition = JSON.parse(await workspace.fileService.readFile({ path: `.forge/runtime/ticket-run-dispositions/${previous.task_id}-run1.json` }));
    if (disposition.run_status !== "blocked" || disposition.reason !== "invalid-before-review" || disposition.accepted_change !== false) throw fail("TICKET_BASELINE_PREVIOUS_RUN", "A5 retry predecessor is not blocked with an invalid review boundary.");
  }
  if (!/^[a-f0-9]{40,64}$/.test(receipt.source_sha ?? "") || !/^[a-f0-9]{40,64}$/.test(receipt.source_tree_sha ?? "")) throw fail("TICKET_BASELINE_GIT", "A5-R2 receipt has an invalid Git identity.");
  const paths = Object.keys(receipt.file_checksums ?? {}).sort();
  if (!paths.length || paths.some((path) => !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path) || path.includes(".."))) throw fail("TICKET_BASELINE_MANIFEST", "A5-R2 manifest paths are invalid.");
  const lines = paths.map((path) => `${path}\t${receipt.file_checksums[path]}\n`).join("");
  if (sha256(lines) !== receipt.manifest_sha256 || !/^[a-f0-9]{64}$/.test(receipt.migration_manifest_sha256 ?? "")) throw fail("TICKET_BASELINE_MANIFEST", "A5-R2 manifest checksum does not match its files.");
  if (sha256(await workspace.fileService.readFile({ path: receipt.migration_manifest_path })) !== receipt.migration_manifest_sha256) throw fail("TICKET_BASELINE_MIGRATION", "A5-R2 migration manifest changed.");
  if (await git(root, "branch", "--show-current") !== receipt.branch || workspace.branch !== receipt.branch || workspace.base_commit !== receipt.source_sha) throw fail("TICKET_BASELINE_GIT", "A5-R2 branch or workspace baseline changed.");
  if (await git(root, "rev-parse", `${receipt.source_sha}^{tree}`) !== receipt.source_tree_sha) throw fail("TICKET_BASELINE_GIT", "A5-R2 source tree differs from approval.");
  if (!existing) {
    if (await git(root, "rev-parse", "HEAD") !== receipt.source_sha || await git(root, "status", "--porcelain")) throw fail("TICKET_BASELINE_GIT", "A5-R2 requires the exact approved clean HEAD.");
    for (const path of paths) if (sha256(await workspace.fileService.readFile({ path })) !== receipt.file_checksums[path]) throw fail("TICKET_BASELINE_SOURCE", `Approved A5-R2 source changed: ${path}.`);
  } else {
    try { await git(root, "merge-base", "--is-ancestor", receipt.source_sha, "HEAD"); }
    catch (error) { throw fail("TICKET_BASELINE_GIT", `Approved A5-R2 source is no longer an ancestor: ${error.code ?? error.message}.`); }
  }
  return { source_tree_sha: receipt.source_tree_sha, manifest_sha256: receipt.manifest_sha256, file_checksums: receipt.file_checksums, contract: receipt.contract, verification_plan: receipt.verification_plan, migration_manifest_sha256: receipt.migration_manifest_sha256, previous_run: receipt.previous_run ?? null, approved_by: receipt.approved_by, approval_recorded_at: receipt.approval_recorded_at };
}
