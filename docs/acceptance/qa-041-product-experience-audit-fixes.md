# QA-041: Product experience audit repairs

## Scope

These repairs follow the review of product iteration commit `37dda4f`.
They enforce ADR-0027's existing Web session and history boundaries; they do
not change Server APIs, database schemas, Bridge behavior or deployment.
Verification uses synthetic credentials and isolated fixtures, with no paid
model invocation, application Release or website publication.

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
