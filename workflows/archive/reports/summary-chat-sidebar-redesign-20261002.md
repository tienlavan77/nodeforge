# Chat Sidebar Redesign Summary

- **Summary ID:** `summary-chat-sidebar-redesign-20261002`
- **Status:** temporary input for `/plan`; not approval or authorization to implement.

## Objective

Redesign the home-page chat sidebar so it is a compact, direct conversation navigator while preserving existing conversation selection, creation, pinning, deletion, project scope, and chat-state behavior.

## Requested scope

1. Add a sidebar control with a recognizable logo/icon that collapses the sidebar toward the left and expands it toward the right.
2. Move the Architecture Manager selector to the top of the sidebar.
3. Remove the visible `Conversations` title.
4. Remove the accordion presentation: show conversation rows directly in the sidebar, with a **New Conversation** button at the top of the list.
5. On conversation-row hover, reveal icon-only actions for pin/unpin and delete.

## Repository context identified

- Canonical home route: `ui/nextjs/app/page.jsx`.
- The current sidebar/region renders a `Conversations` heading and `ConversationsAccordion`.
- The Architecture Manager selector currently renders in the chat panel heading, rather than the sidebar.
- Conversation creation, ordering, pinning, delete API behavior, selection, and local state are currently owned by `ui/nextjs/components/ConversationsAccordion.jsx`, `ConversationsBlock.jsx`, and supporting list/pinning modules.
- Existing direct conversation rows already support pin/delete behavior, but visible actions are text labels; stylesheet rules are in `ui/nextjs/app/styles/conversations.css`.
- Responsive region behavior is defined in `ui/nextjs/app/styles/responsive-workspace.css`; no implementation change has been made.

## In scope

- Canonical home-page sidebar structure, state, styling, responsive/accessibility behavior, and tests needed for the five requested chat-sidebar changes.
- Keeping current API endpoints and existing conversation semantics intact.

## Out of scope

- Backend/API changes to conversation, pin, delete, or Architecture Manager selection.
- Changes to workspace, sprint, message transport/SSE, plan approval, or unrelated legacy UI cleanup.

## Risks and decisions to resolve in planning

- Define collapsed-state content: icon-only navigation versus fully hidden sidebar, plus tooltip and keyboard-accessible expand control.
- Ensure hover-revealed controls remain reachable by keyboard/focus and on touch devices.
- Prevent pin/delete clicks from triggering conversation selection; preserve confirmation/error handling for delete.
- Preserve selected Architecture Manager and active conversation when collapse state or viewport changes.
- Confirm desktop/tablet/mobile breakpoint treatment without horizontal overflow.

## Acceptance outline

- The sidebar collapses/expands through an accessible, icon-bearing control.
- The Architecture Manager selector appears before conversation controls in the sidebar.
- No standalone `Conversations` heading or accordion disclosure remains in the sidebar.
- New Conversation is the first conversation-list action and rows are visible directly below it.
- Hover/focus exposes icon-only pin and delete actions, with accessible labels and functional operations.
- Conversation selection, optimistic messaging, persistence, API scoping, and responsive behavior remain intact.
