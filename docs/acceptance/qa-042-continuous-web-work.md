# QA-042: Continuous Web work

## Scope and ownership

This iteration implements [ADR-0028](../adr/0028-preserve-continuous-web-work.md):
actionable Work, authorized search and navigation recovery, scoped unsent work,
and shared session/Room lifetimes. The Server remains the domain authority.
No new service, database migration, deployment option, Bridge change, provider
credential, application Release or website publication is required.

All verification uses isolated synthetic data. The production-browser harness
serves the built Web app from temporary loopback-only local/trusted Servers.
It never reads the user's application database or forwards model requests.

## Product behavior

- Work creates a Task in the selected authorized Room and opens its detail.
  Next-action shortcuts only navigate: input/start goes to that Task in Room,
  review to Results, and recovery to the exact original Run. No shortcut
  approves a Result, acknowledges an outcome or starts an execution.
- Server search covers authorized Tasks, including unloaded pages. It matches
  literal case-insensitive title substrings or exact numeric/`TASK-n` display
  numbers. Trimmed search is limited to 100 Unicode code points and participates
  in cursor identity; blank/omitted searches preserve old callers.
- URLs preserve Team, Room, one current Task, view, detail tab/Run and Work
  filters. Direct links, reload and back/forward revalidate access before
  restoring. Invalid, ambiguous or inaccessible links return to Work with a
  useful explanation. Share links exclude tokens, draft content and receipts.
- Unsent drafts and failed ordinary messages use bounded User/Team/Room/Task
  session storage. Drafts survive switching and reload within this tab for
  24 hours; closing the tab or changing devices is not guaranteed recovery.
  Restored pending messages are uncertain/failed and never auto-send. Explicit
  retry validates current recipients and retains the exact payload/client ID.
  Logout and session expiry clear this User's saved unsent work.
- Storage failure leaves editing usable with a visible not-saved warning.
  Malformed data, scope mismatches, TTL and capacity limits are tested. Clear
  Draft affects only the current draft, not independent failed submissions.

## Lifecycle and pagination regressions

`useWebSession` records synchronous authority before protected reads and owns
one stable expiry listener. `useRoomSynchronization` binds callbacks to one
session/Room lifetime, owns polling/timers/visibility cleanup and consolidates
snapshot, delta and backward-history commits. Old same-Room callbacks,
A-to-B-to-A navigation and old-session 401s cannot act on a replacement.

Tests exposed and corrected two additional product defects:

1. Workbench sorting used localized ID collation but cursor continuation used
   binary comparison. Equal timestamps and mixed-case/punctuation IDs could
   omit Tasks. Both now share one binary total order. Fixed-ID regression
   fixtures previously returned only three of eight Tasks; all eight now
   traverse without omissions for search/no-search and several page sizes.
2. A late initial snapshot waiting on Run output could remove a newly created
   Task and switch its draft back to the old Task. Creation now reconciles
   before exposing selection. Successful snapshot, Run/output, settings and
   roster commits have independent ordering gates, so late settings can finish
   initialization without restoring old Task or Run lists. App regressions
   cover creation with and without sending a message before the late snapshot.

The controller suite also covers failed newer reads, both full/events response
orders, first-read failure recovery, exhausted history and non-rewinding live
cursors. The existing 201-message regression retains all messages and reads
the next live event from cursor 201 after the extra creation refresh.

## Browser observations

The in-app browser exercised the built app, not a development mock UI:

- Created `QA042` Tasks from Work and stayed in their detail in the same Room.
- Searched by title and exact Task number; search returned the expected work.
- Verified start, Result-review and unknown-outcome shortcuts selected the
  intended Room/Results/Run surfaces without invoking their mutation controls.
- Changed a detail tab by keyboard and verified the URL; reload preserved it.
- Entered an unsent draft, reloaded, navigated to Work and used back/forward;
  the correct Task and exact draft were restored without sending.
- Copied an allowlisted Work link and verified Chinese/English success text.
- Opened an invalid-tab link; a visible explanation accompanied the Work
  fallback with the invalid target removed from the URL.
- Inspected desktop 1280, narrow 720 and phone 390 pixel layouts in dark/light
  themes. Document width equaled viewport width, and the create/search controls,
  Task selection and composer remained usable. The viewport override was reset.
- The browser console contained no errors or warnings during these flows.

JSDOM plus real temporary Server integration additionally covers User/Team/Room
privacy, unavailable targets, delayed navigation, actual session revocation,
logout cleanup and no automatic retry. These are separate from the browser
observations and do not imply physical Bridge/platform or paid-provider testing.

## Verification

The final `npm test` run passed **660 tests**: Server 335, Web 220, contracts 14,
Bridge UI 42, QA policy/evidence 32, product fixture 2 and website 15. Generated
contracts, Web/Server TypeScript and Go contract checks also passed.

`npm run build` passed for all workspaces. The entry bundle remains above
Vite's existing 500 kB advisory threshold; code splitting is not claimed here.
`npm run validate` passed all 9 schemas and 133 fixtures. Compose/Caddy
configuration validation and maintained Markdown lint passed.

Go verification uses task-scoped writable `GOCACHE` and `GOMODCACHE`; the first
attempt could not write the sandbox's default user cache. No global permission
or ownership change was made. Some old UI fixtures used IDs shorter than the
wire contract; those fixtures were corrected without weakening URL validation.
Existing session/history tests were updated only for deliberate URL restoration
and the additional creation refresh, retaining their security assertions.

Delivery state is recorded only in [TASKS](../TASKS.md).
