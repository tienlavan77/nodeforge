<!-- Modal migration inventory: current owners and shared dialog adoption path. -->
# Modal migration inventory

The shared accessible primitive lives in `components/Dialog.jsx`. Its caller owns whether a dialog is open and its business state; `Dialog` owns only presentation, focus containment/restoration, Escape, and outside-click handling. Do not mirror open state inside the primitive.

| Existing modal | Current owner | Migration path |
| --- | --- | --- |
| Add/edit agent | `app/agents/page.jsx` (form and open/edit state); `components/AddAgentModal.jsx` (form presentation) | Replace the backdrop/dialog shell with `Dialog`; keep form data and save lifecycle in the page. |

No other modal owner has been traced for this ticket. Add entries as dialog callers are migrated; caller components remain authoritative for open/close and domain state.
