const REQUIRED_FIELDS = ["id", "roadmap_id", "project_id", "objective", "tickets", "exit_criteria"];
const TICKET_FIELDS = ["id", "project_id", "roadmap_id", "sprint_id", "title", "objective", "acceptance_criteria", "provenance"];

// Keep the browser check aligned with sprint-plan.schema.json without shipping a server-side validator.
export function validateSprintPlan(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["Sprint plan must be a JSON object."];
  for (const field of REQUIRED_FIELDS) {
    if (!(field in value)) errors.push(`Missing required field: ${field}`);
  }
  if (typeof value.id !== "string" || !value.id.trim()) errors.push("id must be a non-empty string.");
  if (typeof value.roadmap_id !== "string" || !value.roadmap_id.trim()) errors.push("roadmap_id must be a non-empty string.");
  if (typeof value.project_id !== "string" || !value.project_id.trim()) errors.push("project_id must be a non-empty string.");
  if (typeof value.objective !== "string" || !value.objective.trim()) errors.push("objective must be a non-empty string.");
  if (!Array.isArray(value.tickets) || value.tickets.length === 0) errors.push("tickets must contain at least one ticket.");
  else value.tickets.forEach((ticket, index) => {
    for (const field of TICKET_FIELDS) if (!(field in ticket)) errors.push(`tickets[${index}] missing required field: ${field}`);
    if (typeof ticket.title !== "string" || !ticket.title.trim()) errors.push(`tickets[${index}].title must be a non-empty string.`);
    if (!Array.isArray(ticket.acceptance_criteria) || ticket.acceptance_criteria.length === 0) errors.push(`tickets[${index}].acceptance_criteria must be a non-empty array.`);
  });
  if (!Array.isArray(value.exit_criteria) || value.exit_criteria.length === 0) errors.push("exit_criteria must contain at least one item.");
  return errors;
}
