# WEB-066 Central visual system goal and acceptance

- State: Frozen implementation goal
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
