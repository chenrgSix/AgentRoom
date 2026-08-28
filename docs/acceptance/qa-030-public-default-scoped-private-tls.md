# QA-030 Public-Default and Scoped-Private TLS

Date: 2026-08-28

Source commit: `9af9edae36ed5fce2cf5b3b2ef06a7cfd91b8d4b`

Status: `ACTIVE` — deterministic, exact-tag and public package gates pass; the
required clean two-physical-host release rehearsal has not run.

## Deterministic Matrix

| Boundary | Evidence | Result |
| --- | --- | --- |
| closed wire contract | 9 schemas, 114 positive/negative fixtures, deterministic TypeScript/Go generation and checks define exact origin/install/epoch/digest, one-CA offer and acknowledgement | PASS |
| Server authority | 154 Server tests include strict controller-file loading, immutable private pairing snapshot, capability echo, authenticated eligible-Device offer, idempotent acknowledgement, mismatch and public/legacy rejection | PASS |
| Web transport | 62 Web tests include public descriptor omission, exact private fragment preservation, private short-code hiding, terminal clearing and no-browser-bypass/no-OS-root copy | PASS |
| Bridge trust | full Go, race and vet gates include no-secret bootstrap, exact-origin private pools for every authenticated client, stage-before-ack recovery, at-most-two roots, lost offer/overlap and new-chain-only promotion | PASS |
| deployment | 18 controller tests plus race/vet/build cover public default/no fallback, named current/next authority generation, 1-of-2 acknowledgement rejection, 2-of-2 commit, current-first rollback, post-rotation reentry and inspected legacy-public migration | PASS |
| real Caddy configuration | the pinned Caddy image validates packaged public/private/manual/legacy profiles and provisions the generated two-named-authority global PKI plus issuer model | PASS |
| repository gates | full workspace tests/builds, 26 Bridge UI tests, 2 QA evidence tests and Markdown lint pass with a task-scoped Go cache | PASS |

## Local Package Closure

Four synthetic Central archives were built from the committed tree with local
version `v0.4.0-qa030.0` for:

- darwin/amd64
- darwin/arm64
- linux/amd64
- linux/arm64

`verify-central-release.sh` reported:

```text
Verified 4 checksum-pinned Central release archives for v0.4.0-qa030.0
```

This synthetic version was not tagged, uploaded, or published. The archives
were temporary local packaging evidence only; they do not authorize or replace
a GitHub Release workflow.

## Exact-Source Continuous Integration

Main CI run
[33137517161](https://github.com/chenrgSix/AgentRoom/actions/runs/33137517161)
passed on exact commit `9af9edae36ed5fce2cf5b3b2ef06a7cfd91b8d4b`.
Repository, Go, native macOS Desktop, and native Windows Desktop jobs passed
locked dependency installation, contract generation and validation, production
builds, workspace tests, deterministic cross-process E2E, documentation and
patch checks, real Compose/Caddy configuration validation, full Go tests and
vet, four-platform Central packaging, and native Desktop package smoke checks.

## Protected Release Workflow

Annotated tag `v0.4.0-qa030.1` resolves to the exact CI commit. Release run
[33137746589](https://github.com/chenrgSix/AgentRoom/actions/runs/33137746589)
validated the empty Draft, tested the tagged Bridge, and built five portable
Bridge CLI archives, two native macOS Desktop archives, one Windows Desktop
portable archive and current-user installer, four checksum-pinned Central
archives, four independent Central checksum pins, the outer checksum file, and
four license files.

The native Windows job passed Desktop test and vet plus install, in-place
upgrade, uninstall, protocol registration, and owner-state preservation smoke
checks. The tagged verifier accepted exactly 22 assets before upload and again
after downloading the Draft. The Windows Desktop portable ZIP has SHA-256
`5b22e23ad076c00c3bb57edd0696714b006b6370b19fc0a2e483058139c1291f`;
the Windows installer has SHA-256
`f10d1e3f60d87750e91b6bf91e93fdbc0145db940ebe0b8f5979eaff5a5745f8`.

The Draft was published as the
[v0.4.0-qa030.1 prerelease](https://github.com/chenrgSix/AgentRoom/releases/tag/v0.4.0-qa030.1)
at `2026-08-28T03:06:12Z`. Stable Latest remains `v0.2.0`.

## Independent Public Asset Verification

A fresh directory at
`/private/tmp/agentroom-v040qa0301-public-assets.7PCwZY` downloaded every asset
without an authorization header from its public GitHub Release URL. The tag's
committed verifier rechecked checksums, archive closure, launchers,
architectures, embedded versions, Desktop and installer metadata, exact Central
source/schema metadata, separate internal checksum pins, and license contents.
It reported:

```text
Verified 4 checksum-pinned Central release archives for v0.4.0-qa030.1
Verified 22 release assets for v0.4.0-qa030.1
```

## Remaining Physical Gate

`QA-030` is not `DONE`. The exact-tag public package gate now passes, including
native Windows Bridge Desktop and installer assets. Two distinct physical hosts
must still perform one clean run with either:

- `public_ca`, verified only by the Bridge host system trust store; or
- `private_scoped_ca`, bootstrapped from the exact pairing link and retained
  only in Bridge owner state.

The reviewed record must confirm no CA was installed into the Bridge host OS,
no leaf fingerprint or Server Token was copied, no TLS verification was
disabled, the installed deep link opened, the verification phrase matched, and
the same Device completed online plus offline/reconnect work. Until that record
exists, `QA-002` and `QA-028` remain blocked and the old manual-CA diagnostic
cannot be promoted.

A later [sanitized physical observation](evidence/qa-030-20260828-partial.md)
confirms that this exact private-scoped package has now consumed one Windows
amd64 pairing session, published two managed Agents, passed the explicit Runtime
self-test and local installer digest check, and completed an exact queued Run
after the same Device reconnected with one reply. It remains partial because
the packaged Server exposed a terminal historical Delivery as pending; the
`RUN-013` fix is not yet in an exact physical candidate, and the safe Codex
version plus final human no-OS-CA/no-bypass attestations are not yet in one
schema-v2 record.
