import { ConfigurationError } from "../../shared/errors.js";

const VERIFICATION_TERMS = /(?:\btest(?:s|ing)?\b|\bbuild(?:s|ing)?\b|\btypecheck\b|\blint\b|\bverify\b|\bverification\b|\bkiểm\s*tra\b|\bkiểm\s*thử\b|\bxác\s*minh\b)/iu;

/** Selects acceptance criteria relevant to the agent role. */
export function filterCriteriaForRole(criteria, role = "coder") {
  if (!Array.isArray(criteria)) throw new ConfigurationError("Acceptance criteria must be an array.");
  if (criteria.some((criterion) => typeof criterion !== "string" || !criterion.trim())) throw new ConfigurationError("Acceptance criteria must contain non-empty strings.");
  if (typeof role !== "string" || !role.trim()) throw new ConfigurationError("Agent role is required.");
  if (role.trim().toLowerCase() !== "coder") return Object.freeze([...criteria]);
  return Object.freeze(criteria.filter((criterion) => !VERIFICATION_TERMS.test(criterion)));
}

export const verificationCriteriaPattern = VERIFICATION_TERMS;
