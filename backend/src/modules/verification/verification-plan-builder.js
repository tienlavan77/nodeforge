import { ConfigurationError } from "../../shared/errors.js";

const UI_PREFIXES = ["ui/nextjs/", "ui/src/", "web/src/", "frontend/src/"];

/** Build a deterministic, allowlisted verification plan from changed paths. */
export function buildVerificationPlan({ commitId, filesChanged = [], scope = "targeted", includeTests = false } = {}) {
  if (typeof commitId !== "string" || !commitId) throw new ConfigurationError("Verification plan requires commit_id.");
  if (!Array.isArray(filesChanged)) throw new ConfigurationError("Verification plan requires files_changed array.");
  const paths = filesChanged.map((entry) => typeof entry === "string" ? entry : entry?.path).filter(Boolean);
  // Keep the orchestration name while emitting the schema-level verification value.
  const verificationLevel = scope === "targeted" ? "focused" : scope;
  const isUi = paths.some((path) => UI_PREFIXES.some((prefix) => path.startsWith(prefix)));
  const checks = [];
  if (includeTests) checks.push({ type: "test", command: "pnpm test", timeout_ms: 120000 });
  const uiDir = paths.some((path) => path.startsWith("frontend/")) ? "frontend" : "ui/nextjs";
  checks.push(isUi ? { type: "lint", command: `pnpm --dir ${uiDir} lint`, timeout_ms: 30000 } : { type: "lint", command: "pnpm --dir backend lint", timeout_ms: 30000 });
  checks.push(isUi ? { type: "build", command: `pnpm --dir ${uiDir} build`, timeout_ms: 60000 } : { type: "typecheck", command: "pnpm --dir backend typecheck", timeout_ms: 30000 });
  return Object.freeze({ schema_version: "1.0", commit_id: commitId, levels: [verificationLevel], checks });
}
