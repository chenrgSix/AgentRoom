# WEB-066 Central visual system goal and acceptance

- State: Accepted
- Date: 2026-09-04
- Owner: Web UI
- Depends on: WEB-065, QA-055

## Goal

Replace the green-tinted Central interface with a calm, high-trust software
execution control plane. The redesign must improve hierarchy, legibility and
product identity across the complete existing Web surface without changing any
domain command, authorization rule, navigation target or evidence meaning.

The visual direction is **Graphite Control Plane**: neutral graphite surfaces,
cool indigo interaction accents, and semantic green reserved for successful or
healthy state.

## Required behavior

1. One documented token system owns dark and light canvas, surface, border,
   text, accent, focus, success, warning and danger colors. Neutral surfaces do
   not carry a green tint.
2. Brand, primary action and selection use indigo. Green is not a generic
   button, navigation, focus or decorative color and remains available for
   positive state only.
3. Product Shell, sidebar, headers, dialogs, menus, buttons, form controls,
   cards, tabs, badges and empty/error/loading states share the same surface and
   interaction hierarchy in both themes.
4. Work, Task detail, Room, Discussion, Plan, Evidence, Agent, Device, Member,
   Security and account surfaces adopt the system without hiding or reordering
   authoritative facts.
5. Ordinary body and control text remains readable; identifiers, digests and
   commits alone use the monospace family. Dense metadata may be compact but
   critical labels and actions do not depend on 8 px text.
6. Borders provide ordinary grouping. Shadows and glow are reserved for
   floating overlays or focus, and motion remains restrained and respects
   reduced-motion preferences.
7. Existing 1280 px, 760/720 px and 390 px layouts retain usable actions,
   visible focus, bounded content and zero page-level horizontal overflow.

## Compatibility and non-goals

- This task is presentation-only. It does not change Server contracts,
  execution state, proof authority, repository behavior, authentication,
  routing or persistence.
- Existing Chinese/English text and dark/light preference behavior remain.
- No new illustration system, marketing site redesign, Bridge Desktop redesign
  or operating-system native theme integration is included.
- A color replacement alone is insufficient: completion requires hierarchy,
  typography, density, surface and semantic-state consistency.

## Acceptance

- focused structural tests prove token ownership, neutral surfaces, semantic
  color separation, minimum critical typography and responsive/focus rules;
- all Web component tests and TypeScript/build gates pass;
- production-browser review covers representative Work, Task, Room, Plan,
  Evidence and management states in both themes at desktop and narrow widths;
- screenshots contain no clipped controls or horizontal page overflow and the
  browser console has no new warning or error caused by the redesign;
- docs lint, whitespace validation and isolated temporary-directory cleanup
  pass;
- completion evidence records exact commands and limitations before `WEB-066`
  becomes `DONE`.

## Accepted delivery

Central now loads `visual-system.css` after every existing feature stylesheet.
That final presentation authority defines one dark/light semantic token system
for canvas, structural surfaces, borders, text, focus, indigo interaction and
success/warning/danger/info state. The existing layout files continue to own
component geometry; Server facts, DOM order, commands, URLs and authorization
remain unchanged.

The resulting **Graphite Control Plane** uses near-black graphite in dark mode
and cool white/gray in light mode. Brand marks, primary actions, selected
navigation, active work and discussion state, Agent identities and integration
types use indigo. Green is limited to actual positive state such as an active
authorization, online/ready status, completed Run, healthy presence or passed
feedback. Warning, danger and informational state retain separate roles.

Shared overrides cover the Product Shell, responsive navigation, access and
setup screens, forms, menus, dialogs, cards, Work, Task overview, Plan,
Evidence, Room/composer, Agent, Device, Member and account/security surfaces.
Critical metadata is at least 11 px and Task fact values are 12 px; opaque
identifiers, commits and digests use the monospace role. Focus remains visible,
motion is restrained and the reduced-motion media query collapses transitions.

The implementation is retained in independently reviewable commits:

- `d08c2b6` freezes this goal and registers `WEB-066`;
- `214a897` repairs the disposable product preview for the already accepted
  split LAN browser transport, including both trusted Cookie names;
- `a22a3c1` adds the token authority, Central surface coverage and structural
  regressions; and
- `f4e63e1` removes the final non-semantic green from Device and Member
  management while retaining green for active authorization state; and
- `2294358` removes the retired `rail-manage` class whose higher-specificity
  light-theme rules tinted the inactive Work destination green, and adds a
  structural regression that prevents the legacy selector from returning.

## Production-browser evidence

The production Web build was exercised against two fresh, disposable real
Server/SQLite product fixtures. The authenticated trusted-Team browser used the
fixture-only Owner recovery key; no external request or real user data entered
the process.

Dark and light review covered the Work workbench, Task overview, Plan,
Evidence, Room and composer, Agent inventory, Device inventory, Team members
and account/security pages. Computed browser styles confirmed indigo for
generic identity, activity and primary interaction, and green only for the
positive Device authorization state. The Work, Task, Plan and Evidence pages
kept long Task, Plan and digest values bounded.

The default 1280 px viewport and explicit 760, 720 and 390 px viewports all
reported `documentElement.scrollWidth - clientWidth = 0`. The 390 px Task tabs
retained a bounded local horizontal scroller (`clientWidth=360`,
`scrollWidth=606`) without producing page-level overflow. Controls remained
visible at every inspected width. Warning/error browser logs were empty after
the complete navigation pass.

Both preview processes removed their exact owned roots on `SIGINT`:

- `/private/tmp/convene-wire-test-run-dmy696`;
- `/private/tmp/convene-wire-test-run-uk46Si`.

## Verification record

The final gates passed on 2026-09-04:

- focused visual and Task responsive structure: 6/6 tests;
- `npm test --workspace @convene-wire/web`: 281/281 tests plus strict
  TypeScript;
- `npm run test:product-experience`: 3/3 real SQLite fixtures covering local,
  direct-HTTPS trusted Team and LAN-HTTP trusted Team sessions;
- `npm run build`: Server TypeScript, Web production build and all 14 schemas
  plus 258 generated fixtures passed;
- `npm run lint:docs`: 372 maintained Markdown files, zero issues; and
- `git diff --check`: no whitespace errors.

The focused, Web and product suites printed and removed roots
`/private/tmp/convene-wire-test-run-pkbwY4`,
`/private/tmp/convene-wire-test-run-bXPuET`,
`/private/tmp/convene-wire-test-run-9V8mbd` and
`/private/tmp/convene-wire-test-run-DRSiU4`. Explicit before/after inspection of
both `/private/tmp` and the macOS user temporary directory found zero
`agentroom-*`, `agent-room-*`, `convenewire-*` or `convene-wire-*` directories.

The existing Vite large-chunk advisory and pre-existing React test `act(...)`
diagnostics remain non-blocking optimization debt; the production-browser
console itself was empty. This delivery does not redesign Bridge Desktop or the
product site, change behavior, publish a release or update an installed Central
service.

After the accepted browser review, a narrow light-theme screenshot exposed one
remaining inactive Work-navigation tint. The follow-up fix passed 11/11 focused
visual and real-App navigation tests plus strict TypeScript. A concurrent full
Web run passed 279/282 tests; its three client-entry/history timing failures did
not touch the changed navigation or CSS and all affected Work-navigation tests
passed when rerun with the repository's supported Web TypeScript configuration
at concurrency one. Its owned roots were removed after both runs.
