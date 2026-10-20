// Retains the Coder report draft and Node verification wait without turning a slow check into an agent failure.

// Persists verification transitions before returning terminal evidence to the suspended report tool call.
export async function executeReportVerificationWait({ tool, input, context, state, store, taskId, selected, correlationId, projectLogger, checkpointPayload }) {
  // Saves report progress with provider session and completed turns so restart Resume retains existing work.
  async function persist(patch) {
    state.verificationWait = { ...state.verificationWait, ...patch, updated_at: new Date().toISOString() };
    state.resume = { ...state.resume, phase: patch.status === "running" ? "verification_wait" : "verification_report_required" };
    await store.save(checkpointPayload(state, { task_id: taskId, status: "in_progress", correlation_id: correlationId,
      agent_id: selected?.agent_id, provider: selected?.provider, execution_context: context.execution_context,
      changed_paths: [...new Set([...state.changedPaths, ...(context.changed_paths ?? [])])] }));
  }
  const reportContext = { ...context,
    // Announces one durable wait per job while the SDK remains suspended on its existing tool request.
    onVerificationWaiting: async (job) => {
      context.abortSignal?.throwIfAborted();
      await persist({ ...job, report_draft: structuredClone(input), execution_id: context.execution_id });
      projectLogger({ event_name: "ticket.verification_waiting", level: "info", status: "pending",
        message: "Node is verifying the ticket commit. Coder will continue automatically when checks finish; Stop cancels continuation.",
        task_id: taskId, correlation_id: correlationId, source: "ticket-report-verification-wait",
        payload: { agent_id: selected?.agent_id, tool: "report_done", job_id: job.job_id } });
    },
    // Stores real terminal evidence without marking report_done or the ticket as complete prematurely.
    onVerificationSettled: async (outcome) => {
      await persist(outcome);
      projectLogger({ event_name: "ticket.verification_wait_finished", level: outcome.status === "failed" ? "warn" : "info", status: "info",
        message: outcome.status === "stopped" ? "Node verification continuation stopped by owner."
          : `Node verification ${outcome.status}; returning evidence to Coder to ${outcome.status === "passed" ? "finish the report" : "repair the reported cause"}.`,
        task_id: taskId, correlation_id: correlationId, source: "ticket-report-verification-wait",
        payload: { agent_id: selected?.agent_id, tool: "report_done", job_id: state.verificationWait?.job_id, result: outcome.status, artifact_id: outcome.artifact_id, error_code: outcome.error_code } });
    }
  };
  const result = await tool.execute(input, reportContext);
  context.changed_paths = reportContext.changed_paths;
  context.verify_result = reportContext.verify_result;
  state.verificationWait = null;
  return result;
}
