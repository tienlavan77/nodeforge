// Displays scoped Coding Sprint diagnostics without presenting unavailable scope as an empty plan.
import { createElement as h } from "react";
import { normalizeUiError } from "../lib/ui-error.js";

// Gates Sprint controls on a successful dashboard read and provides safe operator reconciliation guidance.
export function CodingSprintDashboardState({ state, children, onRetry }) {
  if (!state || state.status === "loading") return h("p", { className: "dashboard-state", role: "status" }, "Loading Sprint Plan…");
  if (state.status === "error") {
    const error = normalizeUiError(state.error, { fallback: "Sprint Plan is unavailable." });
    const reconciliation = !error.retryable;
    return h("section", { className: "dashboard-state error", role: "alert", "aria-label": "Sprint Plan unavailable" },
      h("strong", null, "Sprint Plan unavailable"),
      h("p", null, error.message),
      error.identifiers?.length ? h("div", null, h("p", null, "Affected IDs (up to 25; not a full inventory):"), h("ul", null, error.identifiers.map((id) => h("li", { key: id }, id)))) : null,
      error.requestId ? h("p", null, "Request ID: ", h("code", null, error.requestId)) : null,
      reconciliation ? h("p", null, "Ask an authorized operator to inspect the full Project Sprint/Ticket inventory and reconcile its immutable plan bindings. After reconciliation, reload this page. Do not repeat approval, handoff, or RUN to resolve this read error.") : h("p", null, "The dashboard could not be loaded. You can retry this read without repeating approval, handoff, or RUN."),
      error.retryable && onRetry ? h("button", { type: "button", onClick: onRetry }, "Retry dashboard load") : null
    );
  }
  if (!state.dashboard?.roadmap?.sprints?.length) return h("p", { className: "dashboard-state", role: "status" }, "No sprints registered in this project.");
  return children;
}
