// Preserves Sprint Leader verification descriptions as canonical notes without weakening executable verification contracts.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const SPRINT_VERIFICATION_STEP_FIELDS = Object.freeze(Object.keys(require("../../../../schemas/governance/ticket.schema.json").properties.verification_plan.items.properties));

// Maps only readable legacy descriptions to notes, retaining all unknown fields and invalid values for strict admission.
export function normalizeSprintVerificationNotes(plan) {
  if (!Array.isArray(plan?.tickets)) return plan;
  let changed = false;
  const tickets = plan.tickets.map((ticket) => {
    if (!Array.isArray(ticket?.verification_plan)) return ticket;
    const verificationPlan = ticket.verification_plan.map((step) => {
      if (!step || typeof step.description !== "string" || !step.description.trim()
        || Object.hasOwn(step, "notes") && (typeof step.notes !== "string" || !step.notes.trim())) return step;
      changed = true;
      const { description, ...canonical } = step;
      canonical.notes = canonical.notes && canonical.notes !== description ? `${canonical.notes}\n${description}` : description;
      return canonical;
    });
    return verificationPlan.some((step, index) => step !== ticket.verification_plan[index]) ? { ...ticket, verification_plan: verificationPlan } : ticket;
  });
  return changed ? { ...plan, tickets } : plan;
}
