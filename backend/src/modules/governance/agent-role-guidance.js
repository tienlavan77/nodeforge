/** Supplies the deployed role rulebook and schema task index before an agent
 * works, so discovering response contracts does not depend on remembering paths. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { agentSchemaEntries } from "./agent-schema-catalog.js";

export const AGENT_ROLE_READMES = Object.freeze({ coder: "workflows/agents/coder/README.md",
  reviewer: "workflows/agents/reviewer/README.md", sprint_leader: "workflows/agents/sprint-leader/README.md",
  architecture_manager: "workflows/agents/architecture/README.md", system_engineer: "workflows/agents/system-engineer/README.md",
  linguist: "workflows/agents/linguist/README.md" });
const root = new URL("../../../../", import.meta.url);

/** Gives every task a concrete lookup ID and preserves free-text owner replies
 * when no structured response is required by the current workflow. */
export function schemaLookupInstructions(role, task) {
  const entries = agentSchemaEntries(role);
  const selected = entries.find((entry) => entry.task === task);
  return `MANDATORY ROLE PREPARATION: read and follow ${AGENT_ROLE_READMES[role] ?? "the assigned role README"} before working. Before structured output call lookup_schema with the schema_id for this task. ${selected ? `Current response schema_id=${selected.schema_id}; delivery=${selected.delivery}.` : "Select the task in the README or call lookup_schema({}) for your role catalog."} If unclear use lookup_schema({intent:"the exact response you need to return"}), select by purpose and delivery, then fetch schema_id. Follow next_cursor and concatenate json_fragment until complete=true; never interpret an incomplete schema. Copy exact Node-issued IDs and evidence, not example placeholders. A schema lookup grants no execution or approval authority. Ordinary owner chat remains in the owner's requested format unless the task explicitly requires structured data.`;
}

/** Loads only bundled role paths and hashes their exact bytes. Callers with a
 * retained matching hash may omit unchanged content from a resumed SDK session. */
export function agentRoleGuidance(role, { previousHash } = {}) {
  const path = AGENT_ROLE_READMES[role];
  if (!path) return { path: null, sha256: null, prompt: "" };
  const content = readFileSync(new URL(path, root), "utf8");
  if (!content.trim() || Buffer.byteLength(content) > 32_000) throw new Error(`Role README is unavailable or exceeds the instruction budget: ${path}.`);
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { path, sha256, prompt: previousHash === sha256 ? "" : `NODE-LOADED ROLE README: ${path} sha256=${sha256}\nRead these role instructions before doing the task.\n${content}\n${schemaLookupInstructions(role)}` };
}
