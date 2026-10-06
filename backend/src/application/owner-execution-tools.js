// Records Forge tool boundaries for direct System Engineer recovery without saving tool inputs or outputs.
import { ConfigurationError } from "../shared/errors.js";

// Wraps owner Forge tools with durable receipts and stops new calls after a pause.
export function checkpointOwnerTools({ registry, checkpoint, conversationId, executionId, signal, sessionReady, toolContext }) {
  return Object.fromEntries(Object.entries(registry).map(([name, tool]) => [name, {
    // Runs a Forge tool only while the execution lease is active and records its outcome.
    async execute(input, context = toolContext) {
      if (signal.aborted) throw signal.reason;
      await sessionReady?.();
      const step = await checkpoint.beforeTool(conversationId, executionId, name, input);
      try {
        const result = await tool.execute(input, context);
        await checkpoint.afterTool(conversationId, executionId, step, result, context?.changed_paths ?? []);
        if (signal.aborted) throw signal.reason;
        return result;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        await checkpoint.failTool(conversationId, executionId, step, error);
        if (error?.code === "CHECKSUM_MISMATCH") throw Object.assign(new ConfigurationError("Workspace changed; manual reconciliation is required before continuing."), { code: "EXECUTION_RECONCILIATION_REQUIRED" });
        throw error;
      }
    }
  }]));
}
