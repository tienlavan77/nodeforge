// Defines agent-requested verification environments independently of source
// snapshots. Agents choose a supported environment; Node owns its provisioning.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Reuses the canonical exchange property so both roles and server validation
// advertise exactly the same supported environment values.
export const verificationRunnerEnvironmentSchema = Object.freeze(require("../../../../schemas/governance/agent-exchange-payload.schema.json").$defs.verification_request.properties.environment);

// Rejects arbitrary provisioning commands, paths and unsupported environments
// before any runner or verification process is started.
export function assertVerificationRunnerEnvironment(environment) {
  if (environment !== undefined && !verificationRunnerEnvironmentSchema.enum.includes(environment)) {
    throw Object.assign(new Error("Verification environment must be project or filesystem_namespace."), { code: "VERIFY_ENVIRONMENT_INVALID" });
  }
  return environment;
}

// Gives Coder and Reviewer the same concise request contract without involving
// coordinating agents in ordinary test execution or granting provisioning tools.
export const VERIFICATION_RUNNER_INSTRUCTIONS = 'When a focused test needs real ACL, read-only or capacity fixtures, explicitly request environment:"filesystem_namespace": Coder passes it to run_check({type:"test",command,environment}); Reviewer includes it in verification_requests. Node checks or starts the runner, serializes checks, and returns receipts to the requesting agent. Do not request a socket path, run provisioning commands, or ask SL to start ordinary verification. Omit environment for ordinary project checks. A successful Coder request is retained for final ticket test verification; it never changes acceptance criteria or grants approval.';
