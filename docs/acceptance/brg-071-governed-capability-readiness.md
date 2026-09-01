# BRG-071 Governed Capability Readiness

Date: 2026-09-01

## Scope

This increment opens only the truthful `prepare` plus `capture` declaration
needed before RUN-018 can freeze and deliver a governed manifest. It does not
mint a grant, create a Run, derive capture intent, start a Runtime, propose a
Result, verify output, integrate code or authorize cleanup.

## Delivered boundary

- `GovernedExecutionCapability.readyGrants` carries 1-64 generated,
  schema-validated `ExecutionGrantSummary` values. The summary is path-free and
  contains no command, environment, token or local repository root.
- Governed readiness now requires one current owner-local grant containing both
  `prepare` and `capture`, plus the existing configured Codex profile, current
  binding and unchanged physical Git source. A prepare-only, expired, revoked,
  foreign, corrupt or unsupported grant is omitted.
- The Device hello advertises only implementation support for `prepare` and
  `capture`; it never carries Agent-specific grants. Each Agent publication
  carries its sorted exact ready-grant summaries only after governed recovery
  and process fencing finish.
- The Bridge rejects an empty, duplicate, revoked, wrong-Device,
  missing-capture or schema-invalid prepared grant set before network
  publication, and rechecks the stable Agent identity before publishing it.
- Central accepts summaries only on the same-epoch owning Agent publication,
  validates Device/Agent identity, operation subset, revocation and duplicate
  grant IDs, stores a detached copy, and exposes a detached snapshot to the
  future manifest admission service. A new hello clears the prior Agent set.

The published summary is routing and admission evidence, not bearer authority.
The RUN-018 Server adapter now matches it to one approved implementation node,
freezes the exact manifest and repeats exact current matching at socket send.
The Bridge still rechecks its immutable local grant, repository, runtime
profile, verifier pins and current Server authority immediately around effects.

## Verification

- `npm test --workspace @convene-wire/contracts` passed 80 Node checks,
  deterministic generation, strict TypeScript checks and the embedded Go wire
  tests.
- Focused Bridge admission, connection and managed-core packages passed through
  `run-with-temp-root.mjs`.
- Focused Server registry and authenticated WebSocket tests passed 36 tests;
  `npm run build --workspace @convene-wire/server` passed.
- `git diff --check` passed.

Every focused command used a unique run-scoped temporary root. The runner
printed cleanup for each exact root, including interrupted diagnostic runs, and
no test used or cleared the user's real temporary directories by glob.

Server plan-to-manifest derivation, the exact manifest-to-grant send fence and
prompt scope projection are now covered by
[RUN-018 governed delivery evidence](run-018-governed-capture-delivery.md).
Required predecessor input selection, a real same-Run Server/Go Bridge/Runtime
acceptance, Result/verification, owner-visible cleanup and physical Runtime
acceptance remain open.
