# BRG-071 Local Repository Registration Increment

Date: 2026-09-01. Scope: actual owner CLI registration, local inventory,
immutable revocation and physical repository identity. Delivery status remains
only in TASKS; this increment does not complete BRG-071.

## Implemented Behavior

- `repository bind` requires explicit local paths, an allowlist covering checkout
  and Git metadata, exact binding/repository IDs, a safe alias and confirmation.
  It validates the current local paired identity and uses bounded Git inspection.
- Registration and revocation live in separate immutable owner-private records.
  Exact replay/reopen preserves timestamps and bytes; different inputs cannot
  replace an existing registration. Successful replay repeats the directory
  durability barrier after an uncertain earlier response.
- The namespace binds exact Central, Team, Device and human owner. No token or
  private path appears in printed inventory. Ordinary commits do not change the
  physical binding; replaced checkouts or replaced authority directories fail.
- `repository revoke` retains a revision-2 tombstone and the original record.
  It requires the reviewed revision and explicit confirmation, never deletes
  Git data, and cannot be undone through bind. Expired token, missing Git and
  removed checkout do not prevent this local authority reduction.
- CLI operations share the existing process owner fence. They do not connect to
  Central, initialize Run state, provision Agent identities or execute the
  configured Runtime. Concurrent callers within the one store serialize.

## Review Findings Resolved

The first focused run exposed an ordering issue: re-registering a revoked
binding whose checkout was moved returned a path error before consulting the
revocation. The implementation now checks the retained tombstone before source
inspection. Revocation and inventory were also separated from Git discovery and
new-registration token-expiry checks, preserving recovery when those are absent.

Read validation rejects duplicate JSON keys, unknown/case-altered fields,
trailing documents, symbolic files, orphan or mismatched revocations, foreign
identity and unsafe Unix permissions. Local paths cannot become wire authority.
The CLI must stop rather than steal a live Bridge/Console owner lock.

## Evidence and Limitations

Focused real-Git tests cover both SHA-1 and SHA-256, unchanged checkout/HEAD,
exact retry after reopen, ordinary later commits, scope expansion, directory
replacement, four identity namespace changes, revocation without source/Git,
concurrent identical retries and malformed owner records. The production CLI
command handler runs against an unreachable loopback Central and a nonexistent
Runtime executable and proves no inbox or Agent identity was created.

This is not real Agent Runtime, Browser/Console UI, two-machine, grant enforcement
or integration acceptance. Native Windows ACL semantics are not inferred from
Unix permission checks. The existing governed-delivery no-start fence remains
unchanged. Task grants, owner runtime/verifier profiles, live revocation,
enforced isolation and production cleanup still belong to BRG-071; RUN-018 and
the later end-to-end gates retain their full original requirements.

## Validation Record

- Full `go test -json ./...`: 360 passing top-level tests across 24 packages,
  including nine new registration/CLI tests. Five existing helper entry points
  skip without their caller flags; the operations package has no tests.
- After the final record-size/path hardening, focused
  `go test -race ./internal/repository ./cmd/convenewire-bridge -run 'TestBinding|TestRepositoryCommand' -count=1`
  passes all nine top-level tests and 28 nested cases, including the four added
  malformed-path/size cases. Earlier full-regression results are not substituted
  for these final targeted checks.
- Full Bridge `go vet ./...`, native CLI build and execution of its `version`
  command pass. Windows amd64 repository tests and CLI, plus Linux amd64 CLI,
  cross-compile successfully; no native Windows/Linux execution is claimed.
- `npm run test:e2e`: seven deterministic compatibility scenarios pass, with
  the opt-in live-provider test explicitly skipped.
- `git diff --check` and Markdown lint pass for 308 maintained files.

The CLI lifecycle tests invoke the production command handler, not a packaged
Desktop UI or a remote service. No provider, release, push or deployment was
performed. The existing no-start regression remains in the full Bridge suite.
