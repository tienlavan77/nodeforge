/** Joins persisted focused-check receipts to final verification without rerunning
 * completed Coder work. Each supplement creates a new immutable artifact bound
 * to the same ticket commit, source and captured project environment. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateCheckCommand } from "../../tools/owner-engineer-tools.js";

/** Reports invalid or stale receipt identities instead of trusting report prose. */
function fail(message) { return Object.assign(new Error(message), { code: "VERIFY_CHECK_IDENTITY_MISMATCH" }); }

/** Converts one source-bound Node receipt into reproducible command evidence;
 * pre-commit results and failed commands cannot establish final acceptance. */
function commandFromCheck(receipt, artifact, taskId) {
  if (receipt.task_id !== taskId) throw fail("Focused check belongs to another ticket.");
  if (receipt.pre_commit !== false || receipt.commit_sha !== artifact.commit_sha || receipt.source_revision !== artifact.source_revision
    || !artifact.environment?.sha256 || receipt.environment?.sha256 !== artifact.environment.sha256) return null;
  if (receipt.status !== "passed" || receipt.exit_code !== 0) return null;
  validateCheckCommand(receipt.command, receipt.type);
  if (!/^[A-Za-z0-9_@./:=*?+\s-]+$/.test(receipt.command) || !/^sha256:[a-f0-9]{64}$/.test(receipt.output_sha256 ?? "")) throw fail("Focused check has incomplete command or output identity.");
  const argv = receipt.command.trim().split(/\s+/);
  const paths = argv.filter((arg) => /^(?:backend\/tests|ui\/nextjs\/tests)\/.+\.test\.[cm]?[jt]sx?$/.test(arg));
  const kind = receipt.type === "test" && paths.length && paths.every((path) => path.startsWith("backend/")) ? "backend_tests" : receipt.type;
  return { kind, scope: "ticket", ...(paths.length ? { test_paths: paths } : {}), argv, exit_code: 0,
    ...(receipt.runtime_environment ? { runtime_environment: receipt.runtime_environment } : {}),
    check_id: receipt.check_id, output_sha256: receipt.output_sha256, output_digest_scope: "full_stream",
    stdout_redacted: receipt.stdout ?? "", stderr_redacted: receipt.stderr ?? "" };
}

/** Adds only explicitly referenced, independently loaded Node checks. A report
 * cannot fabricate command output, change a commit or mutate a saved artifact. */
export function createTicketReportChecks({ taskId, loadContext, updateContext, loadArtifact, loadCheck, saveArtifact, assertIdentity }) {
  return { prepareReportEvidence, assertReportChecks };

  /** Retains completed final checks and publishes an idempotent supplemental
   * artifact before the report and independent Reviewer consume its identity. */
  async function prepareReportEvidence({ artifact, evidence = [] }) {
    const ids = [...new Set(evidence.filter((item) => item.type === "run_check" && /^CHECK-[A-Za-z0-9-]+$/.test(item.reference ?? "")).map((item) => item.reference))].sort();
    const currentIds = new Set(artifact.supplemental_checks ?? []);
    const additions = [];
    for (const id of ids.filter((id) => !currentIds.has(id))) {
      const receipt = await loadCheck(id);
      if (!receipt || receipt.check_id !== id) throw fail("The referenced focused-check receipt was not found for this ticket.");
      const command = commandFromCheck(receipt, artifact, taskId);
      if (command) additions.push(command);
    }
    if (!additions.length) return artifact;
    const context = await loadContext();
    if (context.verification_artifact_id !== artifact.artifact_id || context.review_commit_sha !== artifact.commit_sha
      || context.source_revision !== artifact.source_revision) throw fail("Verification identity changed before focused checks could be attached.");
    await assertIdentity(context);
    const checks = [...currentIds, ...additions.map((command) => command.check_id)].sort();
    const baseId = artifact.supplemental_base_artifact_id ?? artifact.artifact_id;
    const base = await loadArtifact(baseId);
    if (!base) throw fail("Original verification artifact is missing.");
    const commands = [];
    for (const id of checks) {
      const receipt = await loadCheck(id);
      if (!receipt || receipt.check_id !== id) throw fail("A retained focused check is missing.");
      const command = commandFromCheck(receipt, artifact, taskId);
      if (!command) throw fail("A retained focused check no longer establishes passing evidence.");
      commands.push(command);
    }
    const artifactId = `ARTIFACT-${createHash("sha256").update(JSON.stringify([baseId, checks])).digest("hex")}`;
    const supplemented = { ...base, artifact_id: artifactId, supplemental_base_artifact_id: baseId, supplemental_checks: checks,
      planned_commands: [...base.planned_commands, ...commands.map(({ kind, scope, test_paths, argv }) => ({ kind, scope, ...(test_paths ? { test_paths } : {}), argv }))],
      commands: [...base.commands, ...commands] };
    await saveArtifact(supplemented);
    await assertIdentity(context);
    await updateContext(context.version, { verification_artifact_id: artifactId });
    return supplemented;
  }

  /** Revalidates every supplemental command against its persisted receipt on
   * reload so report and review use the same immutable evidence after restart. */
  async function assertReportChecks(artifact) {
    for (const id of artifact.supplemental_checks ?? []) {
      if (!/^CHECK-[A-Za-z0-9-]+$/.test(id)) throw fail("Invalid supplemental check identity.");
      const receipt = await loadCheck(id);
      if (!receipt || receipt.check_id !== id) throw fail("Supplemental check receipt is missing.");
      const expected = commandFromCheck(receipt, artifact, taskId);
      if (!expected || !isDeepStrictEqual(expected, artifact.commands.find((command) => command.check_id === id))) throw fail("Supplemental command differs from its recorded check receipt.");
    }
  }
}
