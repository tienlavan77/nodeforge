// Displays Sprint scope identities without implying an owner approved the immutable plan.
import { createElement, Fragment } from "react";

// Shows available immutable ticket details and identifies scope gaps independently of approval.
export function SprintTicketScope({ sprint }) {
  const details = sprint?.tickets?.length ?? 0;
  const scope = sprint?.ticket_ids?.length ?? details;
  const missing = Math.max(0, scope - details);
  return createElement(Fragment, null,
    createElement("h3", null, `Tickets (${details} details / ${scope} in scope)`),
    missing > 0 && createElement("p", { className: "dashboard-state", role: "status" }, `${missing} scope ticket identities are missing immutable detail.`)
  );
}
