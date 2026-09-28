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

`HomePage` owns workspace composition, agent selection, dashboard/upload data, and agent-process state. Conversation selection is represented by `activeConversationId` (with a ref for current stream correlation) in `HomePage`; `useConversationMessageHistory` owns messages and pagination; `useProjectEventStream` owns project SSE subscription/lifecycle. Responsive drawer state is delegated to `NodeForgeHeader` and its responsive navigation implementation. The legacy `NodeForgeApp` also imports `NodeForgeShell`; this is an active edge inside the dormant legacy subtree, not an import into the canonical route.

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
| `app/NodeForgeApp.jsx` → `components/NodeForgeShell.jsx` | Legacy app imports shell; neither is imported from canonical route | Migrate only deliberately; deprecate, then remove only when repository-wide references are absent |
| `components/NodeForgeShell.jsx` | Legacy shell component; currently consumed by `NodeForgeApp` | Keep while legacy consumer remains |
| `app/NodeForgeApp.jsx` | Legacy app composition; retained, no active route import | Deprecate; remove only after repository-wide import-reference search is clear |
| `components/NodeForgeShell.jsx` | Legacy shell; retained, no active route import | Migrate any remaining consumers, then deprecate and remove only after repository-wide import-reference search is clear |
| Migrated presentational modules named above | Supporting components documented in this README | Keep; migrate remaining consumers incrementally |

No legacy file is deleted as part of establishing this baseline. No legacy file is deleted as part of this baseline. The legacy app-to-shell edge exists; confirm repository-wide references are absent before any eventual removal. Preserve canonical switch, optimistic send, retry, correlation and project/conversation scope behavior above during migration.

## LAN development

The dev server binds to `0.0.0.0`. For access from another LAN device, keep its host IP/network in `allowedDevOrigins` in `next.config.js`; update the list when DHCP or the LAN subnet changes.
