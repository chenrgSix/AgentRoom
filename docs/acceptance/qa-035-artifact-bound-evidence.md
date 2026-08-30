# QA-035 Artifact-Bound Evidence

## Result

Status: `DONE`. The repository implementation, deterministic negative tests,
hosted native Windows previous-stable upgrade, target-host packaged Central
execution and reviewed two-physical-machine schema-v4 record are complete.
Hosted Windows evidence and physical evidence remain separately identified;
neither is used as a substitute for the other.

## Closed code boundaries

- Schema-v4 capture reads and hashes the exact Windows installer and desktop
  ZIP regular files. Both computed digests must equal the reviewed inputs and
  their unique entries in Release `SHA256SUMS`. The ZIP is inspected without
  filesystem extraction: absolute, drive-qualified, backslash, dot-segment,
  duplicate and symbolic-link members fail closed, and exactly one expected
  `ConveneWire Bridge.exe` is hashed.
- A formally packaged Bridge injects the exact Release source commit, computes
  the running executable SHA-256 at process startup, and sends both as one
  optional `bridge.hello` pair. Older and local development Bridges may omit
  both for rolling compatibility; partial or malformed pairs are rejected.
  Central persists the accepted observation without changing pairing identity.
- Central resolves `CONVENE_WIRE_RELEASE_VERSION` and
  `CONVENE_WIRE_SOURCE_COMMIT` as one pair. Development may omit both and emits
  `development`/`unknown`; a Release requires a v-prefixed semantic version and
  one lowercase 40-character commit. `/api/metrics` publishes that exact pair
  once as `convenewire_build_info`.
- Capture requires the running Central Release to equal the authenticated
  current Bridge version and its source commit to equal the reviewed
  `serverCommit`. The persisted hello source must equal that same commit, and
  its executable digest must equal the safely inspected ZIP payload. The
  generated record calls this an authenticated process observation, not remote
  hardware attestation.
- Windows verification requires two distinct installer artifacts. It installs
  the latest published stable package, validates its installed version and both
  protocol handlers, creates representative `bridge.json`, Agent identity and
  durable inbox state, upgrades to the candidate, then proves exact state
  preservation through candidate install and uninstall. It also requires the
  installed candidate executable, candidate staging payload and safely
  inspected executable inside the candidate ZIP to have one SHA-256.
- Main CI and the protected Release workflow obtain the prior stable installer
  independently. The candidate version is deliberately newer in CI so Inno
  Setup exercises an upgrade rather than a downgrade or same-package reentry.
- Installer lifecycle cleanup materializes its directory enumeration before
  counting entries under PowerShell `StrictMode`. An empty newly-created inbox
  is removed, while a pre-existing or non-empty inbox remains owner state;
  enumeration failure still stops the verifier instead of being treated as an
  empty directory.

## Deterministic verification

- Server build-identity unit tests cover development, exact Release identity,
  partial variables, invalid tags and abbreviated or uppercase commits.
- Metrics integration verifies the exact ConveneWire and retained legacy
  identity gauges without exposing prompts, sessions or credentials.
- Evidence tests cover valid public/private TLS profiles plus modified
  installer/ZIP bytes, mismatched Release checksums, unsafe/duplicate/missing
  ZIP members, mismatched live Central identity, and mismatched persisted
  Bridge source/executable observations alongside all existing schema-v4 time,
  connection, Run and privacy negatives.
- Workflow policy tests own the previous-stable download and mandatory verifier
  argument shape. Native Windows execution remains hosted evidence, not a
  result inferred from these text checks.
- Main CI run `33282676255` reached the native Windows install/upgrade verifier
  but exposed a `StrictMode` cleanup failure when the fixture inbox became
  empty. The array-materialization repair added the focused regression.
- Exact-source main CI run `33287636198` and `v0.4.1-qa034.4` Release run
  `33287755768` then passed the native Windows stable `v0.4.0` to candidate
  install/upgrade/uninstall verifier, including owner-state preservation and
  installed/staging/ZIP executable digest equality. The published installer's
  independently downloaded SHA-256 is
  `72239c0cecb27a73ba01710be2f445293479aea75b476573015b5d9e00e5958d`.

## Admission closure

- The physical macOS arm64 Central upgraded from `v0.4.1-qa034.4` to the exact
  `v0.4.1-qa035.1` Darwin arm64 archive. Controller `doctor` passed, and live
  internal metrics emitted Release `v0.4.1-qa035.1` with source commit
  `152892e59e90fe17799274009141b07714262378`.
- Main CI run `33294027654` and protected Draft Release workflow run
  `33294193123` completed successfully for that exact commit. The Draft remains
  unpublished and is not represented as stable release admission.
- The reviewed
  [schema-v4 record](evidence/qa-002-20260830-schema-v4.md) binds the selected
  Release installer and ZIP digests, safely inspected and running Windows EXE
  digest, authenticated Bridge hello, Central build identity, two physical
  hosts, same-Device offline/reconnect and online Runs, bounded metrics, and
  every required human attestation. The verifier result is `PASS`.
- That record separately closes `QA-002`, `QA-028`, and `QA-030`; `BRG-046`
  retains its earlier native and physical console-suppression evidence.
