import { ConfigurationError } from "../../shared/errors.js";

const RECOVERABLE_STATES = new Set(["RUNNING", "PAUSED"]);

export function createRuntimeRecovery({ sessionStore } = {}) {
  if (typeof sessionStore?.loadAll !== "function") throw new ConfigurationError("Runtime Recovery requires an Agent Session Store.");

  return Object.freeze({ recover });

  function recover() {
    const recoveredSessions = sessionStore.loadAll()
      .filter(({ state }) => RECOVERABLE_STATES.has(state))
      .map((session) => ({ ...session }));
    return Object.freeze({ recoveredSessions: Object.freeze(recoveredSessions) });
  }
}
