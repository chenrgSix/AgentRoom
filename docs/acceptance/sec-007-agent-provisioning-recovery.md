# SEC-007 Agent Provisioning Recovery Acceptance

## Result

`SEC-007` closes the ambiguous delivery, acceptance-result loss, local config
failure, and mixed-Bridge-version gaps in owner-scoped central Agent
provisioning.

The Server still never persists a management code. Recovery that requires a new
authorization attempt is user-driven: `pending`, ambiguously `delivered`, and
`configuration_failed` requests reuse the same request and reserved Agent ID
after the owner enters a new code. Other Bridge rejections remain terminal and
require a new request identity.

## Recovery Boundaries

- A Bridge advertises `supportsAgentProvisioning` on its authenticated active
  connection. Omission means unsupported. The Server rejects an online old
  Bridge before request persistence, and the Web does not offer that Device.
- A successful local config replacement followed by a lost `accepted` result
  recovers when the exact Device publishes the exact reserved Agent ID. The
  Agent upsert and request transition to `ready` share one immediate SQLite
  transaction.
- `configuration_failed` preserves the reserved local name binding. The same
  request may be delivered again, and an exact publication also recovers a
  result lost around that retry. A different Agent ID cannot take the binding.
- A failed atomic convergence rolls back both the Agent Registry write and the
  provisioning status, leaving the original request retryable.

## Automated Evidence

The focused Server WebSocket and service regressions prove publication before
acceptance, delayed acceptance after `ready`, transaction rollback,
configuration-failure same-ID retry, capability projection, and old-Bridge
rejection without request persistence. The Web component regression proves
same-ID retry for pending, delivered, and configuration-failed states while
terminal rejection starts a new identity. Go connection coverage proves the
Bridge advertises support only when a provisioning handler exists.

The final verification set on 2026-08-27 was:

- `npm test`: 135 Server, 45 Web, 4 Contracts, and 23 embedded Bridge UI tests
  passed, for 207 JavaScript/TypeScript tests plus generated Go contract checks;
- `npm run build` passed for Server, Web production output, and Contracts;
- `npm run validate` passed 7 schemas and 64 positive/negative fixtures;
- `npm run test:e2e` passed all 4 deterministic cross-process scenarios; the
  explicitly opt-in live Codex/Pi scenario remained skipped;
- `go test -race ./...` and `go vet ./...` passed from `bridge/`;
- `npm run lint:docs` passed.

This acceptance verifies deterministic code and cross-process gates. It does not
claim the optional live Codex/Pi scenario or a physical two-machine deployment.
