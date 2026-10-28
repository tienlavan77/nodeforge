// Displays scoped Coding Sprint diagnostics without presenting unavailable scope as an empty plan.
import { createElement as h } from "react";
import { normalizeUiError } from "../lib/ui-error.js";

/** Limits immutable-plan recovery guidance to API diagnostics that actually
 * identify broken plan bindings; transport and permission errors have other causes. */
const RECONCILIATION_CODES = new Set(["sprint_registry_migration_required", "ticket_plan_scope", "sprint_plan_mismatch",
  "plan_revision_not_found", "plan_file_missing", "plan_hash_mismatch", "plan_file_invalid", "plan_identity_mismatch", "plan_source_mismatch"]);

// Gates Sprint controls on a successful dashboard read and provides safe operator reconciliation guidance.
export function CodingSprintDashboardState({ state, children, onRetry }) {
  if (!state || state.status === "loading") return h("p", { className: "dashboard-state", role: "status" }, "Loading Sprint Plan…");
  if (state.status === "error") {
    const error = normalizeUiError(state.error, { fallback: "Sprint Plan is unavailable." });
    const reconciliation = RECONCILIATION_CODES.has(error.code);
    return h("section", { className: "dashboard-state error", role: "alert", "aria-label": "Sprint Plan unavailable" },
      h("strong", null, "Sprint Plan unavailable"),
      h("p", null, error.message),
      h("p", null, "Error code: ", h("code", null, error.rawCode ?? error.code)),
      error.identifiers?.length ? h("div", null, h("p", null, "Affected IDs (up to 25; not a full inventory):"), h("ul", null, error.identifiers.map((id) => h("li", { key: id }, id)))) : null,
      error.requestId ? h("p", null, "Request ID: ", h("code", null, error.requestId)) : null,
      reconciliation ? h("p", null, "Ask an authorized operator to inspect the full Project Sprint/Ticket inventory and reconcile its immutable plan bindings. After reconciliation, reload this page. Do not repeat approval, handoff, or RUN to resolve this read error.")
        : h("p", null, error.retryable ? "The dashboard could not be loaded. You can retry this read without repeating approval, handoff, or RUN." : "The dashboard could not be loaded. Check the reported error before reloading this page."),
      error.retryable && onRetry ? h("button", { type: "button", onClick: onRetry }, "Retry dashboard load") : null
    );
  }
  if (!state.dashboard?.roadmap?.sprints?.length) return h("p", { className: "dashboard-state", role: "status" }, "No sprints registered in this project.");
  return children;
}
