# QA-036 Post-v0.4.0 Hardening Audit

Date: 2026-08-30

Status: `DONE`.

## Audit closure

The implementation audit closed the transactional Message/Run and reply
projection crash cuts, durable cancellation acknowledgement, credential-origin
binding, single Bridge state ownership and bounded Runtime process trees,
exclusive Central lifecycle authority, immutable Release images,
exact-full-CI Release admission, artifact-bound physical evidence, passive Web
content, wait amplification and authoritative Bridge runtime-schema boundaries.
The owning acceptance records remain the detailed authority for each boundary.

Local clean-tree contract generation and validation, workspace build and unit
tests, deterministic E2E, Bridge and controller Go tests/race/vet/build,
Compose/Caddy, release-policy, real arm64 OCI, cross-platform compilation,
dependency and documentation gates passed during the audit with no unresolved
P0 or P1 finding.

## Native Windows execution

Native Windows CI run
[33292642155](https://github.com/chenrgSix/ConveneWire/actions/runs/33292642155)
on exact commit `ce7627a040d06d2aa4e16ebee535a8fdf3bcb5ca` forced
`go test -count=1 ./... -run Windows -v`. It explicitly executed and passed
`TestConfigureWindowsRuntimeCommandSuppressesConsoleWindow` and
`TestWindowsRuntimeJobTerminatesGrandchild`, closing both the console flag and
Job Object parent/child/grandchild gates without accepting a cached result or
cross-compilation as native execution.

## External admission closure

- `QA-034` binds the Release graph to exact full CI and real immutable Central
  image execution.
- `QA-035` records the exact `v0.4.1-qa035.1` package running on the target
  Central host and the reviewed
  [two-machine schema-v4 PASS record](evidence/qa-002-20260830-schema-v4.md).
- Main CI run
  [33294027654](https://github.com/chenrgSix/ConveneWire/actions/runs/33294027654)
  and Draft Release workflow run
  [33294193123](https://github.com/chenrgSix/ConveneWire/actions/runs/33294193123)
  both passed on exact commit
  `152892e59e90fe17799274009141b07714262378`.
- The Windows operator confirmed the current packaged Bridge self-test, no
  unexpected Runtime console window, canonical configured-client pairing,
  same-Device offline/reconnect completion, online completion and every
  no-CA/no-bypass/no-secret-copy attestation. The schema-v4 verifier binds
  those confirmations to the bounded persisted capture and reports `PASS`.

At this audit's closure, the `v0.4.1-qa035.1` GitHub Release remained an
unpublished Draft prerelease and stable Latest remained `v0.4.0`; this audit did
not itself authorize publication. The later Owner-authorized
[QA-037 stable release](qa-037-v0.4.1.md) independently built, published and
verified `v0.4.1` without mutating that candidate Draft.
