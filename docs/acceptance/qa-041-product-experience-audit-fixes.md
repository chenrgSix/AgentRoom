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
