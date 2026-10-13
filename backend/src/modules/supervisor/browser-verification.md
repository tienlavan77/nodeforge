<!-- Run approved browser checks against committed ticket UI without mutating the live project API. -->
# Ticket browser verification

The ticket verifier executes `browser` steps in Chromium against a bundled,
committed UI fixture. It does not connect to the production API, dispatch real
tickets, approve plans, or delete runtime data.

## Provision tools

Run from the project root:

```sh
pnpm install
pnpm browser:install
```

Playwright and esbuild are root production dependencies managed by pnpm in
`package.json`, `pnpm-lock.yaml` and root `node_modules`. To add or update them,
use `pnpm add -w playwright esbuild`; do not install separate runtime copies.
The browser installer only downloads Chromium. It uses
`PLAYWRIGHT_BROWSERS_PATH=0`, keeping browser binaries with the resolved
`playwright-core` package under `node_modules` instead of runtime or home caches.
The runner uses the same setting. Repeat browser installation after Playwright
updates so Chromium matches the installed package. Installation needs network access.
Verification never downloads tools implicitly. It fails with
`VERIFY_BROWSER_TOOLS_MISSING` if provisioning is incomplete; missing Chromium
or host browser libraries also fail verification, never bypass it.
Installing Linux system libraries is a separate administrator action; this
installer never runs `install-deps` or modifies system packages.

## Approved coverage

`browser-coding-contract.js` maps exact approved assertion text to concrete
scenarios in `browser-coding-scenarios.js`. The current suite implements the ten
Coding panel/Sprint-control assertions used by `TICKET-44DB0ADE-01`, including
AC-10. Every approved viewport runs every assertion. Unsupported assertions
fail with `VERIFY_BROWSER_SCENARIO_REQUIRED`; add a matching Node-owned scenario
rather than downgrading the plan or treating a smoke test as acceptance.

Each receipt records the complete step SHA-256, browser/tool versions, viewport,
and successful assertion list. The verification artifact binds this receipt to
its existing immutable commit, source revision, manifest and command-output
digest. A zero exit without a complete receipt is a failed check. Old test/build
artifacts cannot be reused to satisfy newly enforced browser requirements.
Browser checks run first so unavailable tooling fails before expensive builds.

The complete artifact is still required before `report_done` can succeed.
Human/governance decisions are not supplied by browser tests.

## Focused checks

```sh
node --test backend/tests/unit/browser-verification.test.js
```

To run one approved browser step manually, invoke
`backend/scripts/verify-ticket-browser.mjs` with its base64url-encoded JSON as
the first argument and use the committed ticket archive as the working
directory. Its stdout is the JSON receipt; failure returns a nonzero exit.
Do not use a manual working-tree receipt to approve a different ticket commit.
