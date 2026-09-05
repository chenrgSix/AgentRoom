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
  goal, criterion semantics and completion policy survive; new identity and draft state are
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

## WEB-068 evidence

The 23 focused Result/Task/Markdown tests and Web build pass. Tests cover
Markdown headings/tables and executable-content rejection, report version and
staleness, absent/current review, exact source references, clipboard denial,
download object-URL cleanup, revoked access and late old-context reads.

In the actual trusted preview, TASK-108 Result v1 copied a 1,138-character
report. The physical downloaded `TASK-108-Result-v1.md` matches the clipboard
report byte-for-byte (`cmp`), SHA-256
`2329d38f0001404d199b4a425263f66167ca3d2fc244788eae4ccd157b115663`. The browser event observer timed out even though the
file was saved; physical bytes, rather than that observer, prove download.
No browser warning/error was recorded. Local QA artifacts are under
`var/qa-064-everyday-work/` and are not production data or Release evidence.

## WEB-069 evidence

The 38 focused attention, real-Server navigation, Room synchronization and
management checks pass, together with the Web build. The indicator reads one
matching item with existing `scope=mine` and attention/lifecycle filters,
independent of the visible page. Refreshes coalesce with a trailing reread when
another change arrives; Team switch, logout and denied access clear old facts.
Focus recovery refreshes the current scope.

The actual built preview retains “我的任务待处理 / 查看下一步” in Management.
Clicking it returns directly to the current Task Result review surface. It
shows neither a fabricated total nor any new notification permission prompt.

## WEB-070 evidence

The 23 focused copy/Task-detail checks and Web build pass. Real Fastify/SQLite
tests create a fresh draft, preserve multiline and optional criteria plus the
completion policy, leave the source untouched and inherit no assignments or
execution state. Denied access, source revision drift, session changes and
response loss after an actual commit cannot silently create another Task.

The actual built preview copied TASK-108 through an editable confirmation
dialog into TASK-113, “QA-064 · 可复用草稿”. Its overview reports draft, the same
required criterion and accepted-Result policy, zero attempts and no Run,
Result or assignment. New criterion keys work on LAN HTTP without requiring
secure-context random UUID support.
