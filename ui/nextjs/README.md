# NodeForge Next.js UI

This directory contains the canonical Next.js App Router UI. Vite has been removed from the workspace.

## Commands

Run from the repository root:

```sh
pnpm --filter @nodeforge/ui-nextjs dev
pnpm --filter @nodeforge/ui-nextjs build
```

The migrated Dashboard, HistoryView, SprintSummary, ProjectLogPreview, and formatTicketResponse modules Dashboard/SprintSummary/ProjectLogPreview are presentational Server Components; HistoryView is a Client Component because it owns interactive state.

## Canonical route and import graph

`app/page.jsx` is the canonical home route (`/`). It is the client-owned workspace composition:

```text
/app/page.jsx (HomePage, /)
├── components/NodeForgeHeader.jsx
├── components/NodeForgePanels.jsx
├── components/ConversationsAccordion.jsx
├── components/conversation-response-reveal.jsx
├── components/home-chat-composer.jsx
├── lib/node-client.js                 API client and message intents
├── lib/use-conversation-message-history.js  conversation history owner
├── lib/home-page-event-stream.js      project SSE owner
├── lib/home-page-message-handlers.js  send/retry/stream handlers
├── lib/home-page-conversation-state.js persisted chat state
├── lib/home-page-dashboard.js         dashboard projection/cache
├── lib/home-page-watcher-events.js    event display helpers
├── lib/home-page-constants.js         project and storage identifiers
└── ../../src/architecture-manager-selection.js (selection persistence)
```

The route owns workspace composition and agent selection. Conversation selection is owned by `HomePage` (`activeConversationId` and its ref); message history and pagination are owned by `useConversationMessageHistory`. Project SSE subscription and stream lifecycle are owned by `useProjectEventStream`. Workspace dashboard/upload and agent process state remain in `HomePage`. Responsive drawer state is owned by `NodeForgeHeader` and its responsive navigation implementation, not by the conversation history or stream modules.

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
| `NodeForgeApp` | Dormant legacy application path; not imported by the canonical App Router page | Migrate only deliberately; do not remove yet |
| `NodeForgeShell` | Dormant legacy shell path; not imported by the canonical App Router page | Deprecate after import consumers are migrated; do not remove yet |
| Migrated presentational modules named above | Supporting components documented in this README | Keep; migrate remaining consumers incrementally |

No legacy file is deleted as part of establishing this baseline. Before removing `NodeForgeApp` or `NodeForgeShell`, verify an import-reference search has no remaining consumers and update this table.

## LAN development

The dev server binds to `0.0.0.0`. For access from another LAN device, keep its host IP/network in `allowedDevOrigins` in `next.config.js`; update the list when DHCP or the LAN subnet changes.
