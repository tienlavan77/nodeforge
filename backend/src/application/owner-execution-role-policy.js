// Shares owner execution recovery policy while keeping System Engineer and Architecture records physically isolated.
import { ConfigurationError } from "../shared/errors.js";

const ROLE_POLICY = Object.freeze({
  system_engineer: Object.freeze({
    root: ".forge/runtime/owner-executions", displayName: "System Engineer",
    architectureMutations: false, settleRunChecks: true, allowVerifiedDelete: false, requiresOwnerAuth: false
  }),
  architecture_manager: Object.freeze({
    root: ".forge/runtime/architecture-executions", displayName: "Architecture Manager",
    architectureMutations: true, settleRunChecks: false, allowVerifiedDelete: true, requiresOwnerAuth: true
  })
});

// Resolves an explicitly supported owner role without guessing a default or granting Coder recovery privileges.
export function ownerExecutionRolePolicy(role) {
  if (!Object.hasOwn(ROLE_POLICY, role)) throw new ConfigurationError("Owner execution checkpoint requires an explicit supported role.");
  return ROLE_POLICY[role];
}
