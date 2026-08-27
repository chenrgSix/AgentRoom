# QA-028 One-Install One-Device Onboarding Evidence

Date: 2026-08-28.

Status: `BLOCKED` — deterministic, current-host and matching-package evidence
passes, but the identified second physical machine has not yet executed the
cross-host gate. This document is not a `PASS` record and does not mark
`QA-028` or its `QA-002` dependency done.

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

## Current-commit physical Central evidence

The machine-A Central lifecycle was refreshed on this physical macOS host at
exact commit `3497882dbb0bf60ac9e78f58e9dd17ad26d11a46`. The bounded local
release label was `v0.4.0-qa028.1`; it is evidence input, not a published
Release or compatibility promise.

- `package-central-release.sh` produced Darwin amd64/arm64 and Linux
  amd64/arm64 archives from that commit. `verify-central-release.sh` accepted
  all four checksum-pinned archives against the exact release label and source
  ref.
- The Darwin arm64 archive was extracted into an isolated acceptance area and
  its embedded SHA-256 checksum was verified before execution.
- `agentroomctl install` completed in `direct_https` mode on a non-loopback LAN
  origin with isolated ports. Exact install reentry converged without creating
  a second installation or changing the selected origin.
- `agentroomctl status` reported the expected release, origin, ready step,
  healthy Server and externally bound HTTP/HTTPS listeners.
- `agentroomctl doctor` accepted release checksums, private-file permissions,
  the Compose model, HTTPS readiness and WebSocket ingress. The operator did
  not manually create `.env`, issue certificates with OpenSSL, or supply a
  legacy Server Token.
- Ordinary `agentroomctl uninstall` removed the acceptance containers and
  listeners without purging owner state. The SQLite file retained its inode,
  size and mode; the owner recovery credential retained its inode, size and
  mode `0600`; and the mode-`0600` installation manifest advanced to the
  `uninstalled` step.

This closes the stale machine-A lifecycle concern for the current onboarding
commit. It still does not prove a second physical client, installed deep-link
handling, a credentialed Codex provider, or either cross-host Run. The retained
machine-A state can be brought back by exact reentry when machine B is
available; combining this lifecycle evidence with same-host E2E would still
overstate the product gate.

## Matching Windows Bridge candidate

The same exact source now has annotated tag `v0.4.0-qa028.1` and an unpublished
Draft Release. [Release workflow run 33123963471](https://github.com/chenrgSix/AgentRoom/actions/runs/33123963471)
checked out commit `3497882dbb0bf60ac9e78f58e9dd17ad26d11a46` and passed:

- the tagged Bridge test suite and five portable CLI builds;
- native Intel and Apple Silicon macOS Desktop builds;
- the native Windows amd64 Desktop test, portable package and current-user
  installer lifecycle verification, including install, in-place upgrade,
  uninstall, `agentroom://` registration and owner-state preservation;
- four exact-source, checksum-pinned Central builds;
- the closed 22-asset verifier before Draft upload; and
- a clean Draft download followed by the same complete verifier.

An independent authenticated download of
`agentroom-bridge-desktop_0.4.0-qa028.1_windows_amd64_setup.exe` and the outer
`SHA256SUMS` matched SHA-256
`c89d5e90fba52b15e79155abc378d1fdfb62dff8986d7ccb828708123cb30500`.
The candidate remains Draft and is not a published compatibility claim.
Packaging proves that the matching installer is ready for machine B; it does
not prove that the installer, deep link, local Codex login or either Run has
executed on that physical host.

## Blocking physical gate

`QA-002` remains `READY`, so the dependency of `QA-028` is unsatisfied. A
reviewed `PASS` still requires:

1. machine A reentering the now-verified current committed Central build behind
   HTTPS;
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

The executable procedure and closed evidence input are maintained in
`qa-002-two-machine-managed-agent.md`. The repository verifier cross-checks the
live read-only Server database, internally captured metrics, exact trace chains,
single replies, Device/Agent ownership and path-free Workspace projection; it
also rejects common credential, home-path and private-address shapes before
creating a mode-`0600` Markdown record. Human review must still confirm that the
two sanitized host descriptions identify different physical machines. No code
change or local simulation can produce that missing physical fact.
