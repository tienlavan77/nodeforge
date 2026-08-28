import { ConfigurationError } from "../shared/errors.js";

// Node intake: the existing Architecture Decision Store remains the sole authority.
export function createHumanDecisionService({ decisions, bus } = {}) {
  if (typeof decisions?.append !== "function" || typeof decisions?.getById !== "function") throw new ConfigurationError("Human Decision Service requires the Architecture Decision Store.");
  if (typeof bus?.send !== "function") throw new ConfigurationError("Human Decision Service requires the Communication Bus.");
  const accepted = new Map();
  return Object.freeze({ submit });

  function submit(input) {
    const decision = normalize(input);
    if (accepted.has(decision.decision_id) || decisions.getById(decision.decision_id)) throw conflict(`Human Decision already exists: ${decision.decision_id}.`);
    const proposal = decisions.getById(decision.proposal_id);
    if (!proposal || proposal.project_id !== decision.project_id) throw conflict(`Proposal does not exist: ${decision.proposal_id}.`);
    const stored = decisions.append(decision);
    const audit = bus.send({
      id: `MSG-HUMAN-DECISION-${decision.decision_id}`,
      project_id: decision.project_id,
      sender: { id: decision.actor, role: "project_owner" }, recipient: { id: "NODE", role: "node" },
      message_type: "human.decision.recorded", correlation_id: decision.correlation_id,
      payload: { decision_id: decision.decision_id, proposal_id: decision.proposal_id, decision: decision.decision }, timestamp: decision.timestamp
    });
    const result = Object.freeze({ decision: structuredClone(stored), audit: structuredClone(audit) });
    accepted.set(decision.decision_id, result);
    return structuredClone(result);
  }
}

function normalize(input) {
  const value = structuredClone(input ?? {});
  if (!value.project_id || !value.type || !value.decision_id || !value.actor || !value.actor_role || !value.proposal_id || !value.decision || !value.correlation_id || !value.timestamp) throw new ConfigurationError("Human Decision requires decision_id, actor, actor_role, proposal_id, decision, correlation_id, timestamp, type, and project_id.");
  if (value.type !== "human_governance") throw new ConfigurationError("Human Decision type must be human_governance.");
  if (value.actor_role !== "project_owner") throw new ConfigurationError("Human Decision actor_role must be project_owner.");
  if (!["APPROVE", "REJECT", "CHANGE_REQUEST"].includes(value.decision)) throw new ConfigurationError("Human Decision is invalid.");
  if (["REJECT", "CHANGE_REQUEST"].includes(value.decision) && (!value.reason || !String(value.reason).trim())) throw new ConfigurationError("Human Decision reason is required.");
  return value;
}

function conflict(message) {
  const error = new ConfigurationError(message);
  error.statusCode = 409;
  return error;
}
