// Preserves ordered System Engineer text and commands as one versioned CLI-like reply.
// Other roles retain their existing monitor events; command output and provider envelopes
// are excluded so conversation history never becomes a tool-output archive.
import { randomUUID } from "node:crypto";
import { redactSystemEngineerEvent, systemEngineerEventSecrets } from "../shared/system-engineer-event-redaction.js";
import { createSystemEngineerSdkTranscript } from "./system-engineer-sdk-transcript.js";

// Adapts public provider events only for the SE's owner execution, retaining original
// callbacks and policy checks while publishing ordered, redacted reply snapshots.
export function withSystemEngineerEvents(sdk, { profile, conversationId, correlationId, eventSink, contentType = "text/plain" }) {
  if (!sdk || profile?.role !== "system_engineer") return sdk;
  return { ...sdk, execute: async (request) => {
    const runId = `SE-RUN-${randomUUID()}`;
    const transcript = createSystemEngineerSdkTranscript(runId);
    const secrets = systemEngineerEventSecrets();
    // Sends one versioned reply snapshot before the legacy text callback can batch unrelated blocks.
    const publish = () => {
      const clean = redactSystemEngineerEvent({ ...transcript.snapshot(), content_type: contentType }, secrets);
      if (!clean.entries.length) return;
      const activityId = `SE-EVENT-${randomUUID()}`;
      return eventSink?.({ event_id: activityId, event_type: "agent.activity", timestamp: new Date().toISOString(), task_id: correlationId, conversation_id: conversationId, correlation_id: correlationId,
        payload: { activity_id: activityId, agent_id: profile.agent_id, agent_role: "system_engineer", provider: profile.provider,
          conversation_id: conversationId, correlation_id: correlationId, sdk_run_id: runId, sdk_sequence: clean.revision,
          activity_type: clean.status === "failed" ? "failed" : clean.status === "success" ? "completed" : "progress",
          status: clean.status, summary: "System Engineer reply", sdk_event: clean } });
    };
    try {
      const result = await sdk.execute({ ...request, onEvent: async (event) => {
        if (transcript.accept(event)) await publish();
        await request.onEvent?.(event);
      } });
      transcript.finish(result?.text);
      await publish();
      return result;
    } catch (error) {
      transcript.finish(null, true);
      await publish();
      throw error;
    }
  } };
}
