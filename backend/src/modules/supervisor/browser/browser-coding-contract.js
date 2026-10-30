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
  "For AC-10, exercise existing Sprint Plan rendering, controls, and callbacks with controlled clients and confirm unchanged visible behavior and callback arguments.",
  "Render same-named coders with distinct project/agent keys and verify their summaries never cross panels.",
  "Activate one panel's accessible close control by keyboard and pointer; only that panel disappears.",
  "Deliver same-run working events and verify the closed panel stays absent; deliver a new-run boundary with working status and verify only that agent reopens.",
  "Open multiple identities, close one, wait for the debounced save, and inspect localStorage to confirm only partitioned identity membership is present.",
  "Reload and navigate away/back; verify the same open/closed membership returns, panels initially contain no stored actions, and subsequent buffer delivery refills only matching panels with at most fifty current activities.",
  "Verify restoration and same-run activity do not reopen a closed panel, while a live new-run working boundary does.",
  "Exercise blocked localStorage and malformed saved data; verify the UI remains operable and a diagnostic is recorded.",
  "Populate more than three panels with long activity content and scroll each column independently; measure that its header remains within that scroll container rather than sticking to the whole page.",
  "Verify Git Status is visible at the right of the header, requests the supplied project identity, and remains visible during long column scrolling.",
  "Verify content can be scrolled fully into view below the header and interactive controls are not obscured.",
  "Measure panel positions and computed tracks: the list never exceeds three columns, uses three when sufficient width exists, and reduces to one or two without horizontal overflow.",
  "Verify overflowing rows scroll vertically inside Workspace Agent while its header remains pinned; the top-level monitor retains two columns above 760px and one at or below 760px."
];

// Refuses unsupported prose instead of silently claiming a generic browser smoke covered the approved plan.
export function assertCodingBrowserStep(step) {
  if (step?.kind !== "browser" || !Array.isArray(step.assertions) || !step.assertions.length || step.assertions.some((assertion) => typeof assertion !== "string" || !assertion.trim()) || (!step.scenario_path && step.assertions.some((assertion) => !CODING_BROWSER_ASSERTIONS.includes(assertion))) || (step.scenario_path !== undefined && !isBrowserScenarioPath(step.scenario_path)) || !Array.isArray(step.viewports) || !step.viewports.length || new Set(step.viewports).size !== step.viewports.length || step.viewports.some((width) => !Number.isSafeInteger(width) || width < 1 || width > 10000)) {
    throw Object.assign(new Error("Approved browser assertions have no registered Node-owned scenario. Declare scenario_path for a committed browser module implementing every assertion, or register a legacy scenario. Do not substitute unit tests or skip assertions."), { code: "VERIFY_BROWSER_SCENARIO_REQUIRED" });
  }
}

// Binds custom browser acceptance to a project test module, never an absolute path or runtime file.
export function isBrowserScenarioPath(path) {
  return typeof path === "string" && /^(?:backend\/tests|ui\/nextjs\/tests)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.browser\.m?js$/.test(path);
}
