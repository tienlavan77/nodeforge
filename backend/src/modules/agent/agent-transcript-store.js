export function createAgentTranscriptStore({ onDowngrade = () => {}, protocolStorage, onPersistError = () => {} } = {}) {
  const tasks = new Map();
  return Object.freeze({ append, select });

  function append({ taskId, round, instruction = "", responseSummary = "", fullRequest = "", fullResponse = "" } = {}) {
    if (!tasks.has(taskId)) tasks.set(taskId, []);
    const fullRequestRef = `task/${taskId}/round_${round}/request`;
    const fullResponseRef = `task/${taskId}/round_${round}/response`;
    const entry = { round, instruction, response_summary: responseSummary, full_request_ref: fullRequestRef, full_response_ref: fullResponseRef, full_request: fullRequest, full_response: fullResponse };
    if (protocolStorage?.save) {
      Promise.all([
        protocolStorage.save(fullRequestRef, parseStoredValue(fullRequest), { schemaId: "forge-agent-request" }),
        protocolStorage.save(fullResponseRef, parseStoredValue(fullResponse), { schemaId: "forge-agent-response" })
      ]).catch((error) => onPersistError({ taskId, round, error }));
    }
    const list = tasks.get(taskId).filter((item) => item.round !== round);
    list.push(entry); list.sort((a, b) => a.round - b.round); tasks.set(taskId, list);
    return entry;
  }

  function select(taskId, { mode = "rolling_summary", hybridWindow = 2, maxTokens = 30000 } = {}) {
    const list = [...(tasks.get(taskId) ?? [])].sort((a, b) => a.round - b.round);
    let selected = mode === "full_transcript" ? list : mode === "hybrid" ? list.map((entry, index) => index >= list.length - hybridWindow ? entry : summary(entry)) : list.map(summary);
    while (estimate(selected) > maxTokens && selected.some((entry) => entry.full_request || entry.full_response)) {
      const index = selected.findIndex((entry) => entry.full_request || entry.full_response);
      selected[index] = summary(selected[index]); onDowngrade({ taskId, round: selected[index].round, reason: "context_window" });
    }
    return selected.map((entry) => {
      const visible = { ...entry };
      delete visible.full_request;
      delete visible.full_response;
      return visible;
    });
  }
}

function parseStoredValue(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return { text: value }; }
}

function summary(entry) { return { ...entry, full_request: undefined, full_response: undefined, response_summary: entry.response_summary || entry.full_response.slice(0, 500) }; }
function estimate(entries) { return JSON.stringify(entries).length / 4; }
