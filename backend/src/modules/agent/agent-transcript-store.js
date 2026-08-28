import { randomUUID } from "node:crypto";

export function createAgentTranscriptStore({ onDowngrade = () => {} } = {}) {
  const tasks = new Map();
  return Object.freeze({ append, select });

  function append({ taskId, round, instruction = "", responseSummary = "", fullRequest = "", fullResponse = "" } = {}) {
    if (!tasks.has(taskId)) tasks.set(taskId, []);
    const entry = { round, instruction, response_summary: responseSummary, full_request_ref: `task/${taskId}/round_${round}/request_${randomUUID()}`, full_response_ref: `task/${taskId}/round_${round}/response_${randomUUID()}`, full_request: fullRequest, full_response: fullResponse };
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

function summary(entry) { return { ...entry, full_request: undefined, full_response: undefined, response_summary: entry.response_summary || entry.full_response.slice(0, 500) }; }
function estimate(entries) { return JSON.stringify(entries).length / 4; }
