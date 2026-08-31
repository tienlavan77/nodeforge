# NodeForge Next.js UI

This directory contains the canonical Next.js App Router UI. Vite has been removed from the workspace.

## Commands

Run from the repository root:

```sh
pnpm --filter @nodeforge/ui-nextjs dev
pnpm --filter @nodeforge/ui-nextjs build
```

The migrated Dashboard, HistoryView, SprintSummary, ProjectLogPreview, and formatTicketResponse modules Dashboard/SprintSummary/ProjectLogPreview are presentational Server Components; HistoryView is a Client Component because it owns interactive state.

## LAN development

The dev server binds to `0.0.0.0`. For access from another LAN device, keep its host IP/network in `allowedDevOrigins` in `next.config.js`; update the list when DHCP or the LAN subnet changes.
