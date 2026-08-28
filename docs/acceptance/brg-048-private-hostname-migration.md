# BRG-048 Private hostname migration evidence

- Date: 2026-08-28
- Scope: implementation and deterministic Bridge acceptance
- Physical Windows reconnect: not claimed; retained under the physical QA gate

## Boundary

A paired `private_scoped_ca` Bridge may replace only its exact Central origin
after the candidate serves the already pinned CA and passes normal target
hostname readiness. The bootstrap sends no Device credential. The operation
preserves Device, Team and Owner member IDs, Device token and expiration,
installation ID, trust epoch, CA digest, Agents and local policy.

An active CA rotation, another trust mode, a legacy leaf fingerprint, a
different CA, non-HTTPS target or active configuration-mutation fence remains a
closed failure. If credential persistence succeeds but configuration
persistence fails, the previous credential is restored.

## Evidence

The following commands passed from the exact working tree before commit, using
task-scoped Go caches:

```text
go test ./...
go test -race ./internal/pairing ./internal/console
go vet ./...
npm run test:bridge-ui
GOOS=windows GOARCH=amd64 go test -c ./internal/console
GOOS=windows GOARCH=amd64 go test -c ./internal/pairing
```

Focused coverage proves:

- the same canonical CA digest is accepted at a replacement hostname without
  sending authorization, Cookie or legacy Server Token headers;
- Device credential and scoped installation authority fields are unchanged;
- a different CA digest, active rotation and non-HTTPS target fail closed;
- the Console persists credential and configuration as one rollback-bounded
  mutation and keeps the previous state when configuration writing fails; and
- Console projection still exposes only trust mode, epoch and a 12-character
  digest prefix.

This evidence does not claim a packaged Windows Desktop reconnect. That remains
separate physical-platform evidence after a release containing BRG-048 exists.
