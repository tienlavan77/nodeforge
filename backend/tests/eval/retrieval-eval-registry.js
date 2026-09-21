// Summary: Runs one retrieval evaluation query through the production tool registry.

// Executes the eval candidate lookup with the same authorization and dispatch path as an agent.
export function selectEvalCandidates({ registry, caseItem, limit }) {
  return registry.select_code_graph_candidates.execute(
    { ticket_id: caseItem.id, query: caseItem.objective, context: caseItem.title, limit },
    {
      task_id: `RETRIEVAL-EVAL-${caseItem.id}`,
      capabilities: ["select_code_graph_candidates"],
      eval_harness: true,
      task_context: { title: caseItem.title, objective: caseItem.objective, acceptance_criteria: caseItem.acceptance_criteria, style: caseItem.style },
      scope: "all"
    }
  );
}
