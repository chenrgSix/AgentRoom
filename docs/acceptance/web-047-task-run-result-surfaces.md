# WEB-047 Task, Run, and Result surface acceptance

## Outcome

Work now opens an Overview-first Task detail with separate Runs, Results,
Artifacts, Discussion, and Audit views. The browser composes existing Task,
Result, Artifact, Discussion, event, and Context Manifest authorities; it does
not add a browser state machine or treat the Workbench projection as command
authority.

## Server boundary

- `GET /api/tasks/:taskId/runs` lists one Task's attempts in deterministic
  creation order. `GET /api/runs/:runId` returns one authoritative Run. Both
  revalidate current Room membership.
- Ambiguity acknowledgement, retry, cancellation, Result proposal/review, and
  child-Task creation issue scoped Team change hints only after their owning
  domain service succeeds.
- Result proposal and review append one operation-stable Room system summary.
  Exact retries reuse its client Message identity. The summary carries only
  Result version/state, `TASK-n`, optional completion fact, and an opaque Work
  link; tests prove proposal content and review reason are not copied.
- Existing Result review remains append-only, expected-revision fenced, and
  restricted to the Task Owner or Team Owner. Follow-up creation still uses the
  accepted Result's stable next-action key and one operation identity to return
  the same same-Room child Task after response loss.

Focused verification:

```text
npx tsx --test apps/server/test/run-attempt-manifest.test.ts
1 test passed

npx tsx --test apps/server/test/task-result-service.test.ts
3 tests passed

npm test --workspace @agent-room/server
147 tests passed
```

## Browser behavior and recovery

Overview shows canonical goal/criteria, Owner, assignments, lifecycle and
scheduling, latest Run/Result, open questions, exact evidence-backed required
coverage, budget usage, unknown Provider telemetry, attention, and next action.
The default Room Task is visibly labeled quick Room work.

Run detail shows attempt/retry lineage, exact Run and trigger identities,
authoritative state, instruction, redacted frozen manifest, closed permissions,
explicit omissions, ordered events, terminal ambiguity, and linked Results. It
never exposes a generic Run pause. Result detail preserves the immutable version,
actor, exact sources, claims, evidence references, risks, questions, next
actions, and review decision. Agent-authored text is never edited by review.

Only the Task Owner or Team Owner sees review/follow-up controls; the projected
next action never grants permission. Accept is disabled for stale definition or
criteria revisions. A failed CAS review reloads the authoritative Task and
Results while retaining the same logical operation ID for retry. A failed
follow-up request likewise retains its operation ID so response loss converges
on one child Task.

Focused verification:

```text
npx tsx --test apps/web/test/task-work-detail.test.tsx \
  apps/web/test/room-work-link.test.tsx \
  apps/web/test/markdown-message.test.tsx
7 tests passed

npm test --workspace @agent-room/web
60 tests passed; strict TypeScript passed

npm run build --workspace @agent-room/web
production build passed
```

The component checks include stale-state recovery, stable review and child-Task
operation IDs, a non-Owner with a human next action, malicious Result/event
markup, injected local-path fields, same-origin closed-shape Room links, tab
keyboard behavior, and responsive CSS bounds.

## Isolated browser acceptance

An isolated local Server, temporary SQLite database, and Vite browser session
were exercised without existing Team data. The flow created a Team and Room,
opened the visible quick-work `TASK-1`, then used a product Task with a completed
Fake Runtime Run, frozen manifest, Artifact evidence, and proposed Result.

At 1280 px, the page width and document scroll width both remained 1280 px.
Arrow Right moved roving focus and selection from Runs to Results. Run events
rendered in sequence `1, 2, 3`; no local path or generic pause action appeared.
The Owner accepted the Result, created its keyed follow-up, opened `TASK-3` in
the same Room, and the Room selector retained that Task.

At 390 px, document and body scroll widths remained 390 px. The detail width was
390 px; the six-tab row scrolled inside its 360 px container instead of widening
the page. A later Result proposal produced one `TASK-2` Room link; its Result
body was absent from Chat, and activating the link returned directly to the
authorized Work detail. The browser console reported no errors.

## Boundary retained

The Audit view deliberately reports only revisions, immutable Result reviews,
and Run events available through current projections; it does not invent a
standalone audit history. This closes the central Web surface only. Deterministic
cross-process completion/recovery and a physical managed Runtime with Artifact-
linked acceptance remain the separate `QA-029` gate; installation and physical
Device onboarding remain `QA-028`.
