# QA-064 Everyday Work Efficiency

## Frozen goal

On 2026-09-05 the Owner authorized all five improvements from the current-code
ROI assessment. Make everyday work easier to find, read, deliver and reuse,
and make common plan edits accessible without authoring JSON. Task state lives
only in `docs/TASKS.md`.

## Acceptance boundaries

- Work filters cover attention, Room, Agent and priority using existing Server
  query semantics; links, back/forward, clear filters, empty results, pagination
  and permission/context changes remain correct. Search coalesces rapid input
  and does not submit incomplete Chinese IME composition.
- Result Markdown renders without raw HTML or executable links. Explicit copy
  and Markdown download preserve Result identity/version, current/stale status,
  review, criterion descriptions/claims, sources, risks and open questions.
  Missing evidence remains missing; reviewed claims never become independent
  verification or repository integration. Clipboard failure is actionable.
- Across Work, Room and Management, the sidebar indicates current authorized
  actionable work independently of visible filters and pagination. It uses a
  bounded existing query, not a fabricated total or a new notification service.
  Logout, changed Team, denied access and late replies cannot retain old data.
- Copy Task opens an editable draft and requires explicit creation. Title,
  goal and criterion semantics survive; new identity and draft state are
  Server-created. Assignments, history, Results, grants and approval do not copy.
- A bounded common-field plan form preserves every unedited full-definition
  field. Goal, Agent and budget edits create a new revision using existing
  validation and CAS; no form action approves or executes a Plan. Advanced JSON
  and stale/response-loss recovery keep their current behavior.

## Verification strategy

Each implementation commit includes focused behavioral and relevant negative
tests. QA-064 records complete relevant suites/build/schema/docs, deterministic
cross-process compatibility and actual built-page interaction at desktop,
720 px and 390 px in both themes, including a downloaded report and no horizontal
overflow or unexpected console errors. All temporary preview data/processes are
owned and removed. Evidence below must state any untested boundary honestly.

This iteration does not publish a Release, deploy to the existing Central,
change repository authority, require a paid model or close BRG-013, WEB-050 or
QA-038 physical/specialized admission gates.

## WEB-067 evidence

The 40 focused Web checks cover new filter URL parsing, exact Server query
parameters, abort/late-page fencing, composed input and the existing pagination,
search, navigation and work-entry behavior. Tests run from `apps/web` through
`run-with-temp-root.mjs`; all owned roots are removed. Web TypeScript/Vite build
passes, retaining the existing large-chunk advisory.

The actual built trusted-Team preview selected `needs_approval` through the
quick button and returned only TASK-108, with the matching canonical URL and
one loaded result. Desktop and 390 x 844 layouts were inspected; the narrow
page reports `clientWidth=scrollWidth=390`. Final combined browser and complete
regression acceptance remains QA-064.
