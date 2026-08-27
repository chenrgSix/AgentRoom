# WEB-046 Team Workbench acceptance

## Outcome

The authenticated browser now opens on Work. One Team-scoped endpoint returns a
rebuildable projection of Tasks from only the Rooms the current Member may
access. The browser does not enumerate Rooms to assemble the page, and every
command continues to authorize against its owning aggregate rather than the
projection.

## Server evidence

- `GET /api/teams/:teamId/work-items` accepts bounded Mine/Team, Owner, Room,
  lifecycle, attention, priority, assigned-Agent, UTC update and cursor filters.
- Pages sort by derived update time descending and opaque Task ID ascending.
  The cursor binds the Team and normalized filter fingerprint; a changed Team or
  filter rejects it.
- Mine contains Tasks owned by the current Member or assigned to one of that
  Member's Agents, intersected with current Room membership.
- Each row returns all attention records plus the fixed primary reason, the
  latest Run with an explicit unknown diagnostic phase when absent, latest
  Result currency, current Artifact-backed required-criteria count, budget
  usage with `null` Provider telemetry, and the Server-derived next action.
- Task and Result mutations issue Room-scoped Team change hints. The hint wakes
  projection reconciliation but carries no review, lifecycle or Room authority.

Focused verification:

```text
npx tsx --test apps/server/test/workbench-service.test.ts
1 test passed

npm run build --workspace @agent-room/server
TypeScript build passed
```

The regression proves stable two-page traversal, filter/cursor mismatch
rejection, all declared filter families, a current Result with Artifact-backed
coverage, explicit unknown Provider telemetry, latest Run projection, a Team
change wakeup, same-Team Room exclusion, Mine semantics and non-member denial.

## Browser evidence

The default Work surface groups needs-human-action, execution, review, blocked
or at-risk, recent completion and otherwise visible work. Cards display the
Team-local `TASK-n` label while their callback carries the opaque Task ID. All
attention reasons remain visible. Criteria use an exact satisfied/required
count; no percentage is invented. Missing Provider tokens render as Unknown.

```text
npx tsx --test apps/web/test/work-workspace.test.tsx
2 tests passed

npm test --workspace @agent-room/web
55 tests passed; strict TypeScript passed

npm run build --workspace @agent-room/web
production build passed
```

The component regression also checks that raw Task IDs and guessed percentages
are absent from rendered text and that the 760 px layout collapses to one
bounded card column. Existing Room/Discussion/onboarding tests explicitly enter
Chat after confirming Work is the new authenticated default.

## Boundary retained

This task adds the Workbench list and attention queue only. Overview-first Task
detail, frozen Run diagnostics, immutable Result review/follow-up controls and
their isolated browser acceptance remain owned by `WEB-047`; end-to-end and
physical Runtime evidence remains owned by `QA-029`.
