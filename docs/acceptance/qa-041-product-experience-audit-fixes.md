# QA-041: Product experience audit repairs

## Scope

These repairs follow the review of product iteration commit `37dda4f`.
They enforce ADR-0027's existing Web session and history boundaries; they do
not change Server APIs, database schemas, Bridge behavior or deployment.
Verification uses synthetic credentials and isolated fixtures, with no paid
model invocation, application Release or website publication.

## Delayed Run recovery

A retry's stale-response catch unconditionally invoked an old detail refresh.
After local sign-out/reentry, that refresh started a new request using the
revoked Bearer token, so its 401 expired the replacement UI session. Recovery
commands and derived detail requests now check their originating session and
view lifetime before further reads, callbacks or state changes. Detail scope
also includes Task, member and token; replacing the token detaches the old
recovery controls even when the selected Run is unchanged.

The seven new tests in `apps/web/test/recovery-session.test.tsx` cover detached
acknowledgement/retry successes and transport failures, same-Run token
replacement, and a late first detail response that must not start child reads.
The integration case uses the real App and Fastify routes with a temporary
SQLite database and manual Agent. Normal sign-out revokes the old token;
normal reentry creates a valid new one. Releasing the already-committed old
retry response issues no stale-token request or expiry event. The exact receipt
survives, and an explicit replay resolves to the same Run rather than another
attempt. The fixture closes the Server and removes its own temporary directory.

All 27 recovery/detail tests pass. Command, from `apps/web`:

```sh
node ../../node_modules/tsx/dist/cli.mjs --test test/recovery-session.test.tsx test/task-work-detail.test.tsx test/recovery-receipt.test.tsx
```

## Immediate session expiry

The expiry listener captured `session === null` from the loading render.
An immediately rejected first Team-list request could therefore leave an
authenticated shell without a valid session. A synchronous session/mode ref
now records activation before protected requests start; the stable expiry
listener reads that ref, and idempotent clearing chooses the correct entry
gate. Local bootstrap shares the same activation path.

Before the fix, the new trusted/local status-restoration and member/Owner
recovery tests failed; the local-bootstrap case already reached its local
gate through its catch handler. After the fix, all 12 tests in
`apps/web/test/session-expiry.test.tsx` pass, including public recovery-code
401s, protected 403s, delayed old-session successes/errors and body parsing.

Command, from `apps/web`:

```sh
node ../../node_modules/tsx/dist/cli.mjs --test test/session-expiry.test.tsx
```

## Room history recovery

When any request in the initial Room snapshot failed, reconciliation could
restore recent messages but discarded that tail page's older cursor. A
separate per-Room initialization flag now restores the backward boundary from
the first committed tail page, whether it arrives through initial loading,
reconciliation or an action-triggered Room refresh. The flag is checked at
commit time, not request start. A null cursor after reaching the beginning of
history therefore remains final; neither incremental pages nor a concurrent
older tail response can reset it.

The initial-recovery regression failed before the fix: a 200-message Room
showed only its last 100 messages without a history button after a transient
Run-list failure. It now loads all 200 and keeps them during live updates.
A concurrent room/full refresh regression additionally holds a history read
pending while an older tail response arrives, forces a transient history
failure, and proves the retry retains its exact boundary. All 300 messages
remain reachable; a subsequent live delta advances from sequence 300 to 301
rather than rewinding to the old tail or historical page.

Cross-review exposed one additional cut within the same history repair: a
successful initial snapshot could wait for Run output while the user created
a Task, sent a message and loaded history through an action-triggered refresh.
The delayed initial snapshot then replaced all 201 visible messages with its
old 100-message page while leaving the history cursor exhausted. The new
UI-action regression reproduced that loss before the final correction. Initial
snapshots now merge messages and only advance the live checkpoint; the test
preserves all 201 messages and subsequently reads live sequence 202 from
cursor 201, not the old cursor 200.

All nine context-race tests pass; together with session-expiry coverage the
two full files pass 21 tests. Command, from `apps/web`:

```sh
node ../../node_modules/tsx/dist/cli.mjs --test test/context-races.test.tsx test/session-expiry.test.tsx
```

## Final automated verification

Final implementation source: `daef26f`, including session activation fix
`75cb210` and recovery-lifetime fix `78bbbd3`. The final full test run includes
all 15 new regression cases; no production source changed after it started.

| Command | Result |
| --- | --- |
| `npm test` | 570 passed: Server 328, Web 137, contracts 14, Bridge UI 42, QA policy/evidence 32, product fixture 2, site 15; generated contracts, TypeScript and Go contract checks also passed |
| `npm run build` | Server, Web and contracts passed; Web entry bundle remains above Vite's 500 kB advisory threshold (587.22 kB minified, 179.76 kB gzip) |
| `npm run validate` | 9 schemas and 125 fixtures passed |
| `npm run test:e2e` | 6 deterministic cross-process tests passed; 1 opt-in live Codex/Pi case intentionally skipped |
| `npm run test:compose` | Default/custom Central ports and Caddy configuration valid |
| `npm run lint:docs` and `git diff --check` | Passed |

The new recovery fixture's owned temporary-directory count is zero after
completion. Tests do not use the user's database or a real provider. This
repair reruns component/integration and deterministic cross-process checks;
it does not claim a new interactive-browser visual acceptance, native
packaging run, physical-platform acceptance or live-provider certification.
Changes are local commits only: no push, deployment, website republish or
application Release is performed.
