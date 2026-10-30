<!-- Records the sidebar-free Coding layout regression and focused verification without claiming browser acceptance. -->
# Coding workspace layout regression — 2026-10-11

## Sidebar restoration — current state

Owner clarified that Coding must retain its navigation sidebar. The prior single-child layout fix below addressed the squeezed workspace but did not restore the missing navigation; it is historical, not the desired final layout.

- Restored ConversationSidebar before CodingWorkspaceMonitor and restored its open/close state.
- Kept `showConversationControls={false}`: agent selection, New conversation and conversation accordion remain disabled per the earlier Coding requirements. Workspace links, project navigation and theme/collapse controls remain available.
- Replaced the single-column shell with desktop sidebar + remaining workspace tracks, including a 42px collapsed sidebar.
- Mobile uses the existing drawer with a visible 56px navigation rail; Coding-scoped rules avoid the Home rule hiding that rail. Desktop sidebar positioning remains normal above the component's 640px drawer breakpoint.
- Kept viewport/scroll constraints and the existing inner Sprint Plan/Workspace Agent split. No backend or approval changes.

Focused command recorded below rerun: PASS, exit 0. Run `VERIFY-RUN-fc743551-0dfc-4680-88ce-68997de64f59`; evaluated `2026-10-11T07:04:13.506Z`. Updated layout tests assert restored sidebar ordering/control gating and expanded/collapsed/mobile rules. These are source-level assertions, not rendered browser witnesses.

Current individual identities: page `bb60afc28112ea2cd662b2f0553a0f9f80762e9c4cb9faca22ebf5c948a6ab85`; styles `01a1368e0dd31d71ff74ae5ee8a2fb00483b7a8dfe0e365980fdf6ade351ad87`; tests `8212bd1b8819d3c548c24f2ed997afd42037c0b8fe895ee4fca64ffe5cbc409e`. No source/test changes after the check. No commit/push or rollout; workflows remain internal.

## Historical cause confirmed in source

`app/coding/page.jsx` currently renders only CodingWorkspaceMonitor inside `claude-home-shell`; the conversation sidebar is absent. Home CSS assigns that shell `350px minmax(0, 1fr)` tracks. The only child therefore occupies the 350px first track, squeezing the Sprint Plan and Workspace Agent inner grid. This is a concrete layout contract mismatch, not a browser screenshot reproduction.

## Fix

- Added `coding-workspace-shell` to the Coding wrapper.
- Added scoped one-column/one-row wrapper rules in workspace-monitors.css, loaded after Home CSS.
- Coding monitor fills the wrapper with min-width/min-height zero, viewport-bounded height and scrolling. Columns use border-box sizing and wrap long content.
- Existing internal desktop 1:2 split and mobile stacking breakpoint remain unchanged.
- No Home/System layout, backend/API, agent controls, sidebar reinstatement or approval semantics changed. Existing unrelated edits were preserved.

## Verification

One focused check:

```text
node --test ui/nextjs/tests/coding-workspace-layout.test.js ui/nextjs/tests/coding-plan-approval.test.js ui/nextjs/tests/sprint-plan-panels.test.js
```

PASS, exit 0; `VERIFY-RUN-45aca5ed-9ca3-4161-a977-fef85039472d`, evaluated `2026-10-11T06:58:58.042Z`.

New tests assert the page's scoped wrapper, single-track override, stylesheet order, viewport/scroll constraints, retained inner split and mobile rule. These are source-level layout regressions, not browser computed-layout tests. Plan loader/approval and Sprint panel tests ran in the same focused command.

Individual batch identities (not an atomic source-bound manifest):

- `ui/nextjs/app/coding/page.jsx`: `3a6633361ad8fd8198769b4f2fabd6076e861ff2bb6500cfc2c7aac7a4fdbd0d`.
- `ui/nextjs/app/styles/workspace-monitors.css`: `96a561a876e3c168c855dbce1d43ab27e3768be0295f311169296e5bd2190d9f`.
- `ui/nextjs/tests/coding-workspace-layout.test.js`: `449c254034ba662bb37162529b093477570e363089fd45bf2225da2f331e3597`.

No source/test changes after the check. Raw TAP, Node version and rendered browser/network evidence were not supplied. No browser/screenshot tool is provided in the permitted Forge toolset. Visual confirmation on the deployed desktop/mobile page remains open; this does not claim every possible Coding issue is resolved.

No commit/push or rollout performed. The execution ledger includes unrelated historical changes and workflows; the exposed commit tool cannot select a batch subset. Internal workflows must not be staged or unignored. No RUN or database mutation performed.
