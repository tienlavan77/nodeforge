import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

// Builds v1.4 envelopes and keeps changing transcript content outside cache blocks.
export function createAgentRequestBuilder({ expectedSteps = 1, transcriptStore, maxTranscriptTokens = 30000 } = {}) {
  let stableFingerprint;
  let contextVersion = 0;
  return Object.freeze({ build });

  function build({ taskId, stepId, stableContext, dynamicContext, conversationMode = "rolling_summary", hybridWindow = 2, responseSummary = "", fullResponse = "" } = {}) {
    if (typeof taskId !== "string" || !taskId || !Number.isInteger(stepId) || stepId < 1) {
      throw new ConfigurationError("Agent request requires task_id and positive step_id.");
    }
    const stable = structuredClone({ objective: "", constraints: [], project_structure: "", ...stableContext, _cache_control: "ephemeral" });
    const fingerprint = createHash("sha256").update(JSON.stringify(stable)).digest("hex");
    const changed = stableFingerprint !== undefined && stableFingerprint !== fingerprint;
    if (stableFingerprint === undefined || changed) {
      stableFingerprint = fingerprint;
      if (changed) contextVersion += 1;
    }
    const transcriptEntry = transcriptStore?.append?.({ taskId, round: stepId, instruction: dynamicContext?.instruction ?? "", responseSummary, fullRequest: JSON.stringify(dynamicContext ?? {}), fullResponse });
    const transcript = transcriptStore?.select?.(taskId, { mode: conversationMode, hybridWindow, maxTokens: maxTranscriptTokens }) ?? [];
    return {
      schema_version: "1.4", task_id: taskId, step_id: stepId,
      cache_enabled: expectedSteps >= 3 && !changed,
      conversation_mode: conversationMode,
      ...(conversationMode === "hybrid" ? { hybrid_window: hybridWindow } : {}),
      transcript: transcriptEntry ? [...transcript.filter((entry) => entry.round !== stepId), transcriptEntry] : transcript,
      stable_context: stable,
      dynamic_context: {
        instruction: "",
        files: [],
        history_summary: "",
        ...structuredClone(dynamicContext ?? {}),
        metadata: { ...(dynamicContext?.metadata ?? {}), context_version: contextVersion, stable_context_sha256: fingerprint }
      }
    };
  }
}
