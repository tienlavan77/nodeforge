// Maps the approved Coding panel browser assertions to concrete Node-owned browser scenarios.
export const CODING_BROWSER_ASSERTIONS = [
  "For AC-1 and AC-13, use controlled existing-contract events and directory fixtures to render one Sprint Leader, two Coders, and one Reviewer and assert exactly four separate panels.",
  "For AC-1 and AC-14, verify each visible name and role against the corresponding directory profile.",
  "For AC-1, AC-4, and AC-15, emit distinguishable actions for each agent and assert each action appears only under its exact agent and current project, including identical names and roles.",
  "For AC-2, AC-6, and AC-16, start an agent with no panel and verify automatic opening; delay directory delivery and verify no misleading attribution before sufficient evidence arrives.",
  "For AC-2, AC-7, and AC-17, deliver repeated events, reconnect events, and multiple steps and assert panel count and stable panel elements do not duplicate.",
  "For AC-2, AC-8, and AC-18, exercise running-to-idle-to-running, success, failure, and activity-buffer eviction; verify the same unclosed panel element remains.",
  "For AC-3, change event IDs, timestamps, and display labels without changing project or agent identity and verify panel element continuity.",
  "For AC-5, supply missing, malformed, ambiguous, and foreign-project identity and verify no incorrectly attributed panel or action.",
  "For AC-9, disconnect the source and restore cached panel presence without live evidence; verify honest unknown or disconnected state rather than a claim of current execution.",
  "For AC-10, exercise existing Sprint Plan rendering, controls, and callbacks with controlled clients and confirm unchanged visible behavior and callback arguments."
];

// Refuses unsupported prose instead of silently claiming a generic browser smoke covered the approved plan.
export function assertCodingBrowserStep(step) {
  if (step?.kind !== "browser" || !Array.isArray(step.assertions) || !step.assertions.length || step.assertions.some((assertion) => !CODING_BROWSER_ASSERTIONS.includes(assertion)) || !Array.isArray(step.viewports) || !step.viewports.length || step.viewports.some((width) => !Number.isSafeInteger(width) || width < 1 || width > 10000)) {
    throw Object.assign(new Error("Approved browser assertions have no registered Node-owned scenario. Add a matching browser scenario; do not substitute unit tests or skip assertions."), { code: "VERIFY_BROWSER_SCENARIO_REQUIRED" });
  }
}
