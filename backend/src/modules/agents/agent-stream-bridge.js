import { ConfigurationError } from "../../shared/errors.js";
import { redactSensitiveText } from "../context/secret-paths.js";

export function bridgeAgentStream({ agent, internalBus, redact = redactSensitiveText } = {}) {
  if (!agent?.on || !agent?.off || !internalBus?.emit) {
    throw new ConfigurationError("An agent process and internal bus are required for stream bridging.");
  }

  let agentId;
  const onMessage = (envelope) => {
    agentId = envelope.sender.id;
    internalBus.emit("agent.stream", Object.freeze({ source: "agent.stdout", agent_id: agentId, message: envelope }));
  };
  const onStderr = (text) => {
    internalBus.emit("agent.stream", Object.freeze({ source: "agent.stderr", agent_id: agentId, text: redact(text) }));
  };

  agent.on("message", onMessage);
  agent.on("stderr", onStderr);
  return () => {
    agent.off("message", onMessage);
    agent.off("stderr", onStderr);
  };
}
