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

## Project browser modules

New browser steps declare `scenario_path` in the immutable verification plan:

```json
{
  "criterion_ids": ["AC-1"],
  "kind": "browser",
  "scenario_path": "ui/nextjs/tests/navigation.browser.mjs",
  "assertions": ["Save updates the status"],
  "viewports": [375, 768, 1440]
}
```

Use a `.browser.js` or `.browser.mjs` module under `backend/tests/` or
`ui/nextjs/tests/`. Traversal, absolute paths, runtime paths and module symlinks
outside the committed archive are rejected. The Coder implements this file in
the ticket commit; the module counts against the ticket's file budget.

The module exports:

- `createBrowserFixture({sourceRoot, build})`: return `{html, assets}`. `html`
  is nonempty HTML; `assets` maps local URL paths (e.g. `/fixture.js`,
  `/fixture.css`) to text content. Use the provided esbuild function to bundle
  **actual components from sourceRoot** with `write:false`; controlled external
  I/O can be replaced, but do not recreate the behavior under test in mock DOM.
- `browserAssertions`: an object whose own keys match **every approved
  assertion string**, with async functions taking `{page, viewport, origin}`.
  `page` is a Playwright page, `viewport` the approved width in CSS pixels.
  Assert real DOM/behavior and throw on failure. These functions return no
  evidence; Node creates the receipt.

Node validates the contract, serves the fixture on a temporary loopback port,
opens a fresh page for each assertion at every approved width, and blocks
browser requests outside that fixture origin. Context storage is shared within
one viewport; use reload/navigation within a scenario for lifecycle checks.
Uncaught browser page errors also fail the check. Like other repository tests,
modules execute Node code; this contract is not a sandbox for untrusted code.

Sprint admission rejects browser prose without a supported scenario or a planned
module path. Before workspace mutation or Coder reservation, RUN also validates that each browser
step has a supported legacy scenario or a valid planned module path and that
root browser tools/Chromium are installed and Chromium can actually launch. A planned module need not exist yet:
Coder is responsible for implementing it. Missing exports, missing committed
files or failing assertions remain verification failures, with no PASS receipt.
SL and Coder prompts describe this same contract. A runner repair changes the
runner fingerprint, allowing a bounded retry of the same committed ticket.

## Legacy approved coverage

`browser-coding-contract.js` maps exact approved assertion text to concrete
scenarios in `browser-coding-scenarios.js`. The current suite implements the ten
Coding panel/Sprint-control assertions used by `TICKET-44DB0ADE-01`, including
AC-10, plus the three identity/accessible-close/next-run lifecycle assertions
approved for `TICKET-CODING-PANELS-dfb362ac-01`. These lifecycle scenarios exercise
same-named agents, foreign-project events, Enter-key and pointer closing,
same-run working/idle/working, reconnect, and explicit new-run reopening while
retaining the other agent's DOM panel. The four presence assertions approved for
`TICKET-CODING-PANELS-dfb362ac-02` run the committed Coding page itself with
controlled directory/stream clients and real localStorage. They cover debounced
identity-only saves, reload/navigation, buffer refill, retained closure with a
delayed directory, next-run reopening, and logged storage failures. Only external
I/O and unrelated sidebar chrome are replaced; page effects and panel components
come from the exact source archive. Five layout assertions for ticket `…-03` also
run real committed components, seven overflowing panels, independently scrolling
columns, sticky headers, project-scoped Git status and reachable controls. Every approved viewport runs every assertion. Unsupported assertions
fail with `VERIFY_BROWSER_SCENARIO_REQUIRED`; add a matching Node-owned scenario
rather than downgrading the plan or treating a smoke test as acceptance.

The focused lifecycle regression can use `NODEFORGE_BROWSER_COMMIT=<commit>`
to bundle an isolated Git archive of that exact ticket UI. It uses the existing
project Chromium/CDP test helper; this regression is not a ticket evidence
artifact. The production Playwright runner still requires its supported Node
runtime and generates the immutable browser receipt through ticket verification.

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
TMPDIR=/tmp node --test backend/tests/unit/browser-verification.test.js backend/tests/unit/ticket-verification-contract.test.js
TMPDIR=/tmp NODEFORGE_BROWSER_TEST=1 node --test backend/tests/unit/browser-project-scenario.test.js backend/tests/unit/browser-coding-layout.test.js
```

To run one approved browser step manually, invoke
`backend/scripts/verify-ticket-browser.mjs` with its base64url-encoded JSON as
the first argument and use the committed ticket archive as the working
directory. Its stdout is the JSON receipt; failure returns a nonzero exit.
Do not use a manual working-tree receipt to approve a different ticket commit.
