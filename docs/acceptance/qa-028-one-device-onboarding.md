# QA-028 One-Install One-Device Onboarding Evidence

Date: 2026-08-28.

Status: `BLOCKED` — deterministic and current-host evidence passes, but the
required second physical machine has not been made available. This document is
not a `PASS` record and does not mark `QA-028` or its `QA-002` dependency done.

## Accepted deterministic behavior

Commits `8130892` and `99d3371` close the remaining implementation and
cross-process recovery boundaries.

- Device revocation durably disables the Device, all credentials, and its
  managed Agents before reconciling active Runs.
- An unaccepted Delivery becomes `failed` with `RUN_DEVICE_REVOKED`; an
  accepted Delivery becomes `outcome_unknown` with
  `RUN_DEVICE_REVOKED_OUTCOME_UNKNOWN`. An interruptible active connection
  receives a best-effort cancel before socket closure.
- Startup recovery idempotently repairs a crash after the durable Device
  mutation but before Run reconciliation.
- A real TCP Server, compiled Go Bridge CLI, and Bridge Console consume one
  canonical fragment-bearing `agentroom://` link. Owner and Bridge phrases
  match, one Device credential is stored with mode `0600`, and neither the
  config nor process output contains a central Server Token.
- The paired Device publishes two local Agent profiles. The Server projection
  exposes only opaque Workspace references and owner-authored aliases, never
  the absolute Workspace or executable path.
- The Console explicitly runs a managed Pi-protocol Runtime self-test and
  receives `RUNTIME_PROBE_OK`; pairing itself does not trigger the test.
- Stopping the real Console leaves one Run queued. Restarting the same paired
  Console completes it with exactly one reply. A later process loss leaves one
  accepted and one queued Run, and Device revocation gives each its required
  distinct terminal outcome.

Existing focused evidence remains authoritative for create, claim, approval,
poll and decision response loss; manual-code rate limiting; QR/link proof
placement; legacy join/pair and Server Token compatibility; Runtime discovery;
local Workspace save authority; and installer reentry, backup, restore, doctor
and non-purging uninstall.

## Executed current-commit gates

The following gates passed at `99d3371692632c2423696726d18bdb46e9a94505`:

```text
npm run validate
  9 schemas, 98 fixtures
npm run build
npm test
  150 Server, 60 Web, 4 Contracts, 26 Bridge UI = 240 checks
npm run test:e2e
  5 passed, 1 explicitly skipped live-provider case
go test ./...
go vet ./...
go test -tags desktop ./cmd/agentroom-bridge-desktop
go build -tags desktop ./cmd/agentroom-bridge-desktop
npm run test:compose
plutil -lint bridge/desktop/darwin/Info.plist
npm run lint:docs
git diff --check
```

The real Device-onboarding E2E is deterministic and same-host. The managed Pi
protocol is exercised by a bounded test Runtime, not a credentialed provider.
It therefore does not satisfy the physical Codex gate.

## Physical evidence already available

`OPS-008` records successful local and direct-HTTPS installation on this
physical macOS host at commit `991f508`, including exact install reentry,
doctor, WebSocket authentication boundary, backup, staged restore and
non-purging uninstall. The direct installation bound a non-loopback LAN
address and used the installation-local TLS authority.

That evidence proves the Central host lifecycle only. It did not pair or run a
Bridge from a second physical client, and it predates the current onboarding
commits. Combining that record with same-host E2E would overstate the product
gate.

## Blocking physical gate

`QA-002` remains `READY`, so the dependency of `QA-028` is unsatisfied. A
reviewed `PASS` still requires:

1. machine A running the current committed Server/Web build behind HTTPS;
2. a different physical machine B running the matching packaged Bridge with a
   working local Codex login;
3. the canonical deep link reaching the installed desktop/Console flow;
4. an explicit local Codex Runtime self-test;
5. one online nonce Run completing with one trace and one reply;
6. one Run queued while machine B is offline and completing exactly once after
   the same Device reconnects; and
7. a sanitized evidence record containing the two host descriptions, exact
   commit and archive digest, public identifiers, state sequences and metrics,
   with no private address, token, path, prompt, certificate key, or provider
   credential.

The executable procedure and evidence template remain in
`qa-002-two-machine-managed-agent.md`. No code change or local simulation can
produce this missing physical fact.
