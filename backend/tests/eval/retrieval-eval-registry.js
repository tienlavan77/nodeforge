// Summary: Runs one retrieval evaluation query through the production tool registry.

// Executes the eval candidate lookup with the same authorization and dispatch path as an agent.
export function selectEvalCandidates({ registry, caseItem, limit, context = {} } = {}) {
  const taskId = `RETRIEVAL-EVAL-${caseItem.id}`; // Keep each case bound to one deterministic execution identity.
  return registry.select_code_graph_candidates.execute(
    { query: caseItem.query ?? caseItem.objective, context: caseItem.title ?? caseItem.objective, limit },
    {
      task_id: taskId,
      execution_id: context.execution_id ?? taskId,
      conversation_id: context.conversation_id ?? taskId,
      delegation_id: context.delegation_id ?? taskId,
      capabilities: ["select_code_graph_candidates"],
      eval_harness: true,
      task_context: {
        title: caseItem.title ?? caseItem.objective,
        objective: caseItem.objective,
        acceptance_criteria: caseItem.acceptance_criteria ?? [],
        guardrails: caseItem.guardrails ?? [],
        style: caseItem.style
      },
      scope: "all",
      ...context
    }
  );
}
