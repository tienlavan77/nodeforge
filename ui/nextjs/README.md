# NodeForge Next.js UI

This directory contains the canonical Next.js App Router UI. Vite has been removed from the workspace.

## Commands

Run from the repository root:

```sh
pnpm --filter @nodeforge/ui-nextjs dev
pnpm --filter @nodeforge/ui-nextjs build
```

The active `/` route is a Client Component. Its direct imports are the components and `lib` modules shown below; the route also imports architecture-manager selection persistence from `ui/src`. Keep this graph aligned with actual imports in `app/page.jsx`.

## Canonical route and import graph

`app/page.jsx` is the canonical home route (`/`), marked `use client`. Its direct imports (and ownership) are:

```text
/app/page.jsx (HomePage, active route /)
├── next/link
├── components/NodeForgeHeader.jsx              responsive navigation/drawer UI
├── components/NodeForgePanels.jsx              dashboard/process/upload UI
├── components/ConversationsAccordion.jsx        conversation list and selection UI
├── lib/node-client.js                           API client and message intents
├── ../../src/architecture-manager-selection.js architecture-manager selection persistence
├── lib/home-page-constants.js                  project and storage identifiers
├── lib/home-page-dashboard.js                  dashboard projection/cache
├── lib/home-page-conversation-state.js         persisted conversation selection/chat state
├── lib/home-page-watcher-events.js             event display helpers
├── lib/home-page-event-stream.js               project SSE subscription/lifecycle
├── lib/home-page-message-handlers.js           send/retry/stream handlers
├── components/conversation-response-reveal.jsx streamed response presentation
├── components/home-chat-composer.jsx            message composer UI
└── lib/use-conversation-message-history.js      conversation history and pagination
```

`HomePage` composes the workspace, agent selection, dashboard/upload data, and agent-process state. It owns `conversations`, `activeConversationId` and the active-conversation ref used for stream correlation. `useConversationMessageHistory` owns message history, pagination and loading/error state; `useProjectEventStream` owns project SSE subscription/lifecycle. `NodeForgeHeader` owns responsive navigation and its drawer state. The separate `app/NodeForgeApp.jsx` directly imports the legacy `components/NodeForgeShell.jsx`; that edge remains confined to the dormant legacy subtree and neither is imported by the active route. The shell imports `NodeForgeHeader` and `NodeForgePanels`.

## Behavior contract to preserve

- **Switch:** changing the selected conversation updates the active conversation ref and loads that conversation's history; stale stream events must not become messages for the newly selected conversation.
- **Optimistic send:** the composer adds the user's message immediately, then correlates the eventual response to the submitted conversation/message while the send guard prevents duplicate submissions.
- **Retry:** failed or incomplete responses use the existing message-handler retry path and intent constants; preserve the current conversation and stream correlation when retrying.
- **Stream correlation:** SSE events are accepted only for the active conversation and matching response/request correlation; event display helpers may normalize agent names and timestamps but must not change ownership.
- **Scope:** API calls stay scoped to `PROJECT_ID`; conversation history, selection, and stream events stay scoped to the active conversation and architecture-manager context. Do not broaden the route to unrelated projects.

## Legacy path map

| Path | Actual role/import status | Decision |
| --- | --- | --- |
| `app/page.jsx` / `HomePage` | Active `/` route and canonical composition | Canonical |
| `components/*` and `lib/*` imported by `HomePage` | Active UI, state, API, history, and SSE ownership | Keep and evolve |
| `app/NodeForgeApp.jsx` → `components/NodeForgeShell.jsx` | Dormant legacy edge: `NodeForgeApp` imports `NodeForgeShell`; neither is imported by `app/page.jsx` | Migrate deliberately; deprecate, then remove only when repository-wide references are absent |
| `app/NodeForgeApp.jsx` | Dormant legacy app composition; retained and not imported by the canonical route | Deprecate; remove only after repository-wide import-reference search is clear |
| `components/NodeForgeShell.jsx` | Dormant legacy shell; retained because `NodeForgeApp` imports it | Keep while the legacy consumer remains; then deprecate and remove after migration |
| Migrated presentational modules named above | Supporting components documented in this README | Keep; migrate remaining consumers incrementally |

No legacy file is deleted as part of establishing this baseline. The app-to-shell edge is a real import within the dormant legacy subtree; confirm repository-wide references are absent before any eventual removal. Preserve canonical switch, optimistic send, retry, correlation and project/conversation scope behavior above during migration.

## CSS migration map

`app/globals.css` imports the domain sheets in cascade order. The compatibility selectors remain active until the canonical UI and responsive smoke checks pass.

| Stylesheet | Current ownership | Migration status |
| --- | --- | --- |
| `styles/foundation.css` | Theme tokens and common controls; still contains older conversation, composer, history and workspace selectors | Compatibility selectors to move or remove after import audit |
| `styles/legacy-workspace.css` | Dormant `NodeForgeApp` workspace and older composer, sprint and dialog selectors | Remove only after ticket 009 smoke and ticket 010 import audit |
| `styles/shell-layout.css`, `styles/shell-theme.css` | Shared shell, layout and theme | Keep; mobile overrides remain scoped here |
| `styles/home-workspace.css`, `styles/responsive-workspace.css` | Canonical conversation, chat, workspace and Sprint layout | Keep; verify desktop, tablet and mobile overflow before closing migration |
| `styles/agents-directory.css`, `styles/agents-actions.css` | Agent directory and actions | Keep; verify mobile card and dialog behavior |
| `styles/sprint-ticket.css`, `styles/ticket-dialogs.css` | Sprint and ticket surfaces | Keep |
| `styles/conversations.css`, `styles/conversation-dialogs.css` | Conversation list and dialogs | Keep; remove overlapping legacy rules after smoke |

The migration is incomplete while legacy and cross-domain selectors remain in `foundation.css` and `legacy-workspace.css`. Keep both sheets in the import chain until their consumers are removed and visual checks are recorded.

## LAN development

The dev server binds to `0.0.0.0`. For access from another LAN device, keep its host IP/network in `allowedDevOrigins` in `next.config.js`; update the list when DHCP or the LAN subnet changes.
