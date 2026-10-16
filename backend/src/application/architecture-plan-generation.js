// Repairs incomplete Architecture discovery once without weakening evidence validation or owner approval boundaries.
import { parseArchitecturePlan } from "../modules/governance/architecture-plan-response.js";

// Asks Architecture to correct its own missing discovery using actual repository reads before persisting any plan.
export async function generateValidatedArchitecturePlan({ prompt, conversationId, requestArchitecture, validateMarkdown, assertSource }) {
  let markdown = parseArchitecturePlan(await requestArchitecture(prompt, conversationId));
  try {
    await validateMarkdown(markdown);
  } catch (error) {
    if (error.code !== "DISCOVERY_INCOMPLETE") throw error;
    await assertSource();
    markdown = parseArchitecturePlan(await requestArchitecture(`${prompt}\n\nThe previous draft failed validation (${error.code}). Inspect the relevant repository files with the supplied read-only tools before revising. Return a complete replacement Markdown plan with observed [Evidence: path] or [Source: path] references, an explicit Repository discovery complete statement, and labeled Assumptions or Unverified areas. Do not merely assert discovery was completed, invent evidence, repeat owner questions, change confirmed decisions, approve or RUN. If discovery cannot be performed, explain the limitation; do not fabricate a valid plan.\n\nPrevious draft:\n${markdown}`, conversationId));
    await validateMarkdown(markdown);
  }
  return markdown;
}
