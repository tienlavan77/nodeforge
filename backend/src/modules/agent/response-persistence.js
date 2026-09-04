import { ConfigurationError } from "../../shared/errors.js";

export async function persistAgentResponse({ protocolStorage, taskId, round, response, raw = false } = {}) {
  if (!protocolStorage?.save || !taskId || !Number.isInteger(round)) return null;
  const ref = `task/${taskId}/round_${round}/response`;
  try {
    return await protocolStorage.save(ref, response, { replace: !raw, schemaId: raw ? "https://forge.local/schemas/agent/raw-response.schema.json" : "https://forge.local/schemas/agent/envelope.schema.json" });
  } catch (error) {
    const failure = new ConfigurationError(`Unable to persist provider response: ${error.message}`);
    failure.code = "PROTOCOL_RESPONSE_PERSIST_FAILED";
    failure.cause = error;
    throw failure;
  }
}
