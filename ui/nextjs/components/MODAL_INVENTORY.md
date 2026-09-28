<!-- Modal migration inventory: current owners and shared dialog adoption path. -->
# Modal migration inventory

`components/Dialog.jsx` owns shared presentation, portal mounting, focus containment/restoration, Escape, and outside-click behavior. Each caller remains the single owner of open/close and domain state; do not duplicate it inside `Dialog`.

| Existing modal | Current owner | Migration path |
| --- | --- | --- |
| Add/edit agent | `app/agents/page.jsx` (open/edit state and form lifecycle); `components/AddAgentModal.jsx` (form presentation) | Already uses `Dialog`; keep form data and save lifecycle in the page. |
| Create conversation | Conversation page that supplies `open`, title, validation, create, and close props; `components/CreateConversationModal.jsx` renders the modal | Replace its portal/backdrop/dialog wrapper with `Dialog`; retain conversation form and open state in the page. |
| Ticket detail/edit | `TicketCard` in `components/ticket-detail-modal.jsx` owns `viewOpen`, ticket detail, and refresh lifecycle; `TicketModal` renders the detail editor | Replace the modal shell with `Dialog`; keep detail/edit state in `TicketCard` and its existing callbacks, with no second open-state store. |

All listed modal presentations have an identified owner and path to the shared primitive. `CreateConversationModal.jsx` and `ticket-detail-modal.jsx` are confirmed modal users because their indexed JSX includes modal backdrops and dialog/presentation roles; migration of those legacy callers is separate from introducing the primitive.
