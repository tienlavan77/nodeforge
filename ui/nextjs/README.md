# NodeForge Next.js UI

This directory is the temporary Next.js App Router replacement workspace.

The existing Vite application in `ui/` remains the primary runnable UI until
FORGE-MONO-008 verifies that the Next.js application can replace it completely.

## Commands

Run from the repository root:

```sh
pnpm --filter @nodeforge/ui-nextjs dev
pnpm --filter @nodeforge/ui-nextjs build
```

The migrated Dashboard, HistoryView, SprintSummary, ProjectLogPreview, and formatTicketResponse modules originate from the legacy ui/src/main.jsx. That source contains uncommitted FORGE-UI-041/040-era logic and requires owner confirmation before becoming canonical. Dashboard/SprintSummary/ProjectLogPreview are presentational Server Components; HistoryView is a Client Component because it owns interactive state.

## LAN development

The dev server binds to `0.0.0.0`. For access from another LAN device, keep its host IP/network in `allowedDevOrigins` in `next.config.js`; update the list when DHCP or the LAN subnet changes.
