import { ConfigurationError } from "../../shared/errors.js";

export function createRoundCounter({ maxRounds = 15 } = {}) {
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new ConfigurationError("maxRounds must be a positive integer.");
  const counts = new Map();
  return Object.freeze({ increment, get, reset, maxRounds });
  function increment(taskId) {
    if (typeof taskId !== "string" || !taskId) throw new ConfigurationError("Round counter requires task_id.");
    const count = (counts.get(taskId) ?? 0) + 1;
    counts.set(taskId, count);
    return Object.freeze({ task_id: taskId, count, max_rounds: maxRounds, allowed: count <= maxRounds });
  }
  function get(taskId) { return counts.get(taskId) ?? 0; }
  function reset(taskId) { counts.delete(taskId); }
}
