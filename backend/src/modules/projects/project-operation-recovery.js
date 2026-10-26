// Restart recovery for durable project lifecycle operations (O3 foundation).
// Business purpose: after a process restart the backend must reconcile what actually exists before
// resuming any Create/Add work, because a lost or delayed operation snapshot must never remove
// catalog membership, replay an already committed Create, or infer success from mere intent.
// Technical description: recovery is ordered and evidence-collective — catalog membership is read
// first as the sole source of membership, then per-root identity, then the recorded database
// result, then artifact ownership, and a decision is taken only when the gathered evidence agrees.
// Consequences of that agreement rule two previously unsafe shortcuts: a Create whose membership is
// already visible in the catalog is settled from evidence even when its snapshot lagged behind in
// intended/attempted (replay is refused because membership proves the commit), and a recorded
// "succeeded" database result is never sufficient on its own — it must be corroborated by catalog
// membership plus verified artifact ownership, otherwise the contradictory evidence fails closed.
// Only after all checks may an incomplete step be re-run, never while a lease still shows
// unreleased resources. Serving readiness is re-probed inside the current process for every resume,
// so a persisted "ready" style flag is never trusted. Settlement writes use the explicit recovery
// authority, distinct from an attempt token, and recovery never rewrites the catalog.
import { OPERATION_STAGES, validateOperationSnapshot } from "./project-operation-contract.js";

const TERMINAL_STAGES = new Set(["settled", "abandoned"]);
const TERMINAL_OUTCOMES = new Set(["succeeded", "failed", "cancelled"]);

// Builds the recovery coordinator over one operation store and the evidence sources it reconciles.
// `identity` resolves per-root identity, `ownsArtifact` checks artifact ownership, `queryResult`
// reads the database result of a prior attempt, and `verifyServing` probes readiness live.
export function createProjectOperationRecovery({
  store, catalog, identity, ownsArtifact, queryResult, verifyServing
} = {}) {
  if (!store || !catalog || !identity || !ownsArtifact || !queryResult || !verifyServing) {
    throw new Error("Project operation recovery requires store, catalog, identity, ownership, result and serving probes.");
  }

  return Object.freeze({ recover });

  // Reconciles every non-terminal operation and returns one decision per operation. Corrupt
  // snapshots are reported through scan().corrupted and never abort the sweep, so a damaged
  // snapshot alone can neither remove catalog membership nor block healthy recovery.
  async function recover() {
    const { operations, corrupted } = await store.scan();
    const decisions = [];
    for (const snapshot of operations) {
      if (TERMINAL_STAGES.has(snapshot.stage)) continue;
      try {
        decisions.push(await recoverOne(snapshot));
      } catch (error) {
        decisions.push({ operation_id: snapshot.operation_id, action: "blocked_recovery_conflict", reason: error.message });
      }
    }
    return { decisions, corrupted };
  }

  // Runs the ordered, evidence-collective reconciliation for one operation. Catalog membership is
  // authoritative and wins over snapshot state in both directions: committed membership settles a
  // lagging snapshot instead of replaying it, while a lagging or contradictory evidence set fails
  // closed instead of being papered over by whichever single source happens to look convenient.
  async function recoverOne(snapshot) {
    validateOperationSnapshot(snapshot);
    const base = { operation_id: snapshot.operation_id, stage: snapshot.stage, attempt: snapshot.attempt };

    // Membership evidence first: the catalog is the only source of membership, and a snapshot can
    // never remove or invent it.
    const membership = catalog.list().find((entry) => entry.root === snapshot.root) ?? null;

    // Identity evidence: a snapshot project_id that disagrees with the catalog or the per-root
    // identity is a conflict no replay may paper over.
    if (snapshot.project_id && membership && membership.projectId !== snapshot.project_id) {
      return { ...base, action: "blocked_identity_conflict" };
    }
    const knownProjectId = membership?.projectId ?? snapshot.project_id ?? null;
    if (knownProjectId) {
      const resolved = await identity.resolve(snapshot.root);
      if (resolved && resolved !== knownProjectId) return { ...base, action: "blocked_identity_conflict" };
    }

    // Attempt fencing: re-running an unfinished step is allowed, opening a second runtime while
    // the previous attempt still owns resources is not.
    const openLeases = (await store.openAttempts()).find((entry) => entry.operationId === snapshot.operation_id);
    if (openLeases && openLeases.attempts.some((attempt) => attempt >= Math.max(snapshot.attempt, 1))) {
      return { ...base, action: "blocked_attempt_open", held_attempts: openLeases.attempts };
    }

    // Database and artifact evidence are read together, so no single source decides settlement.
    const recorded = await queryResult({ operationId: snapshot.operation_id, projectId: knownProjectId });
    const outcome = TERMINAL_OUTCOMES.has(recorded?.outcome) ? recorded.outcome : null;
    const createCommitted = snapshot.kind === "create" && membership !== null;
    const needsOwnership = outcome === "succeeded" || snapshot.stage === "committed" || (createCommitted && outcome === null);
    const owned = needsOwnership
      ? await ownsArtifact({ projectId: membership?.projectId ?? knownProjectId, root: snapshot.root })
      : false;

    // A recorded success must be corroborated: without membership plus verified ownership the
    // evidence contradicts itself, so recovery neither settles nor replays and fails closed.
    if (outcome === "succeeded" && !(membership && owned)) {
      return { ...base, action: "blocked_evidence_conflict", evidence: { database: "succeeded", membership: Boolean(membership), ownership: Boolean(owned) } };
    }
    // Symmetrically, a recorded non-success for a Create cannot coexist with committed membership.
    if (outcome && outcome !== "succeeded" && createCommitted && knownProjectId === membership?.projectId) {
      return { ...base, action: "blocked_evidence_conflict", evidence: { database: outcome, membership: true } };
    }
    if (outcome === "failed" || outcome === "cancelled") {
      return settle(snapshot, { outcome, projectId: knownProjectId, root: snapshot.root }, base, "settled_from_evidence");
    }
    // Committed membership proves the Create already ran: ownership completes the settlement even
    // when the snapshot never advanced, and replay is refused because re-running would double-create.
    if (membership && (snapshot.stage === "committed" || createCommitted)) {
      if (!owned) return { ...base, action: "blocked_membership_lost" };
      return settle(snapshot, { outcome: "succeeded", projectId: membership.projectId, root: snapshot.root }, base, "settled_from_evidence");
    }
    if (snapshot.stage === "committed") return { ...base, action: "blocked_membership_lost" };

    // A crashed attempt may have left partial ownership without catalog membership; replaying
    // Create on top of it could double-create artifacts, so recovery fails closed for humans.
    const orphan = knownProjectId && await ownsArtifact({ projectId: knownProjectId, root: snapshot.root });
    if (!membership && orphan) return { ...base, action: "blocked_membership_lost" };

    // Nothing committed: a fresh fenced attempt may re-run the unfinished step, but only after a
    // live readiness probe succeeds in this process — a previously stored ready flag is ignored,
    // and a failed probe claims no attempt so no resources can leak behind the fence.
    const readiness = await verifyServing({ root: snapshot.root, projectId: knownProjectId });
    if (!readiness?.ready) {
      return { ...base, action: "blocked_not_serving", detail: readiness?.reason ?? "serving probe failed" };
    }
    const claimed = await store.claimAttempt(snapshot.operation_id);
    return { ...base, action: "replayed", new_attempt: claimed.attempt };
  }

  // Repairs a lagging snapshot to settled with the evidenced outcome by walking each approved
  // intermediate stage under the explicit recovery authority; catalog membership is authoritative
  // and was validated above, so recovery never rewrites membership and never replays work the
  // evidence says already completed.
  async function settle(snapshot, result, base, action) {
    let current = snapshot;
    const start = OPERATION_STAGES.indexOf(current.stage);
    for (const target of OPERATION_STAGES.slice(start + 1)) {
      if (target === "abandoned") continue;
      const last = target === "settled";
      const patch = last
        ? { stage: target, status: statusFor(result.outcome), result }
        : { stage: target };
      current = await store.transition(current.operation_id, current.revision, patch, { recovery: true });
      if (current.stage === "settled") break;
    }
    return { ...base, action, outcome: result.outcome };
  }
}

// Maps an evidenced outcome onto the persisted snapshot status vocabulary.
function statusFor(outcome) {
  return outcome === "succeeded" ? "succeeded" : outcome === "cancelled" ? "cancelled" : "failed";
}
