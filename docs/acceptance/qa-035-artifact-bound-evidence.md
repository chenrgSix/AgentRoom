# QA-035 Artifact-Bound Evidence

## Result

Status: `ACTIVE`. The repository implementation and deterministic negative
tests are complete. A hosted native Windows previous-stable upgrade and a
packaged Central execution remain required before the task can be marked
`DONE`; this record does not substitute macOS or source inspection for either
gate.

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
  empty. The array-materialization repair is local implementation evidence
  only; a successful exact-commit native rerun remains required below.

## Remaining admission evidence

1. Run the native Windows CI/Release verifier against one actual prior stable
   installer and a distinct candidate produced from the resolved Release SHA.
2. Install the next exact Central package and confirm its internal metrics emit
   that Release and source commit.
3. Perform and commit the fresh two-physical-machine schema-v4 record. That
   separately closes `QA-002`, `QA-028`, `QA-030` and `BRG-046` if every human
   attestation also passes.
