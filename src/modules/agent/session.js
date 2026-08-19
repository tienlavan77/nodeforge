import { ConfigurationError } from "../../shared/errors.js";

export const AGENT_SESSION_STATES = Object.freeze({
  CREATED: "CREATED",
  RUNNING: "RUNNING",
  PAUSED: "PAUSED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED"
});

const transitions = Object.freeze({
  CREATED: Object.freeze({ start: "RUNNING", fail: "FAILED" }),
  RUNNING: Object.freeze({ pause: "PAUSED", complete: "COMPLETED", fail: "FAILED" }),
  PAUSED: Object.freeze({ resume: "RUNNING", fail: "FAILED" }),
  COMPLETED: Object.freeze({}),
  FAILED: Object.freeze({})
});

export function createAgentSession() {
  let state = AGENT_SESSION_STATES.CREATED;

  return Object.freeze({ start, pause, resume, complete, fail, getState });

  function start() {
    return transition("start");
  }

  function pause() {
    return transition("pause");
  }

  function resume() {
    return transition("resume");
  }

  function complete() {
    return transition("complete");
  }

  function fail(error) {
    if (error === undefined) throw new ConfigurationError("Agent Session failure requires an error.");
    return transition("fail");
  }

  function getState() {
    return state;
  }

  function transition(action) {
    const next = transitions[state][action];
    if (!next) throw new ConfigurationError(`Invalid Agent Session transition: ${state}.${action}.`);
    state = next;
    return state;
  }
}

export const createSession = createAgentSession;
