// Grounds paraphrased SL/AM reasoning in approved passages instead of treating wording similarity as approval.
import { createHash } from "node:crypto";
import { blockerSprintAuthority } from "./blocker-decision-authority.js";
import { blockerValidationError } from "./blocker-validation.js";

// Issues stable references bound to the current approved text and Architecture identity, never agent-authored sources.
export function blockerAuthorityPassages({ plan, ticket, architecture }) {
  const sources = [{ scope: "sprint", text: blockerSprintAuthority(plan, ticket), basis: null },
    ...(architecture ? [{ scope: "architecture", text: architecture.markdown, basis: architecture.basis }] : [])];
  return sources.flatMap(({ scope, text, basis }) => text.split(/\n\s*\n/).flatMap((paragraph) => paragraph.match(/[\s\S]{1,4000}/g) ?? [])
    .filter((paragraph) => paragraph.trim().length >= 20).map((paragraph) => ({ scope, text: paragraph,
      passage_id: createHash("sha256").update(JSON.stringify([scope, basis, paragraph])).digest("hex") })));
}

// Resolves a supplied reference to trusted source text while allowing a separately explained paraphrase.
export function resolveBlockerAuthority(value, context) {
  if (value.authority_reference === undefined) return value.authority_quote;
  const reference = value.authority_reference;
  if (!reference || typeof reference !== "object" || Array.isArray(reference)
    || Object.keys(reference).some((key) => !["passage_id", "rationale"].includes(key))
    || typeof reference.rationale !== "string" || reference.rationale.trim().length < 20 || reference.rationale.length > 8000) {
    throw blockerValidationError("/authority_reference", "reference_invalid", "Provide a Node-issued passage_id and explain how it authorizes this decision without changing scope or guardrails.");
  }
  const scope = value.authority_scope ?? "sprint";
  const passages = blockerAuthorityPassages(context);
  const passage = passages.find((entry) => entry.passage_id === reference.passage_id);
  const validReferences = passages.filter((entry) => entry.scope === scope).slice(0, 8)
    .map((entry) => ({ scope: entry.scope, passage_id: entry.passage_id, excerpt: entry.text.slice(0, 240) }));
  if (!passage) throw blockerValidationError("/authority_reference/passage_id", "reference_unknown", "Select a passage issued for the declared authority scope from the current Node-verified context. Invented or stale references cannot grant authority.",
    { expected: { scope, references: validReferences }, received: reference.passage_id });
  if (passage.scope !== scope) {
    const error = blockerValidationError("/authority_scope", "reference_scope_mismatch",
      `Reference ${reference.passage_id} belongs to ${passage.scope}, not ${scope}. Use its scope only if the decision is authorized there, or select a passage issued for ${scope}. Node will not infer or widen authority.`,
      { expected: passage.scope, received: scope });
    Object.assign(error.validation_errors[0], { passage_id: reference.passage_id, valid_references: validReferences });
    throw error;
  }
  return passage.text;
}
