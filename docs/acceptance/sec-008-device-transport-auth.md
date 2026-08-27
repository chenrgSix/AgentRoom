# SEC-008 Device Transport Authentication Acceptance

## Corrected boundary

The optional central Server Token gates only the legacy anonymous Bridge
join-request, claim, and invitation-pair bootstrap routes. It is not required
after either legacy or zero-copy pairing has issued a Device credential.
Authenticated Bridge WebSocket and HTTP routes resolve only the Device bearer;
an omitted, wrong, or correct legacy Token neither changes that principal nor
substitutes for a missing Device credential.

This closes the implementation gap against ADR-0021: a new Bridge that promotes
its locally generated poll proof cannot copy a Server Token that the pairing
flow intentionally never receives.

## Regression evidence

The focused Server run passed four cases:

```text
Bridge HTTP publication binds bytes without exposing local storage
central Server Token validation is optional, bounded, and normalized
configured Server Token gates legacy bootstrap but not Device-authenticated transport
zero-copy pairing promotes the poll proof exactly once and survives response loss
4 passed, 0 failed
```

The tests prove:

- missing/wrong Token still rejects legacy join, claim, and pair;
- a wrong Device credential is rejected even with the correct Token;
- a paired Device connects over WebSocket with no Token, a wrong Token, or the
  retained correct Token, preserving rolling compatibility;
- the zero-copy poll proof connects after approval and restart without ever
  receiving the configured Token;
- authenticated workspace/artifact HTTP succeeds with only the Device bearer,
  while a forged Device bearer remains unauthorized.

The full Server suite and production TypeScript build then passed:

```text
139 Server tests passed, 0 failed
npm run build --workspace @agent-room/server
npm run lint:docs
git diff --check
```
