# QA-030 Public-Default and Scoped-Private TLS

Date: 2026-08-28; completion update: 2026-08-30

Initial source commit: `17ae30ee2331ac37fb2dafeb7ee0fa2bd7e9f661`

Current physical candidate commit:
`1b24b0c55c7f70236a66d60fe16362c6e3213b3e`

Status: `DONE`. Deterministic public-default, exact-tag, package and lifecycle
gates remain complete. The reviewed
[schema-v4 evidence](evidence/qa-002-20260830-schema-v4.md) closes the physical
`private_scoped_ca` alternative with current-package execution, live
connection state, exact-origin scoped trust and an explicit review receipt.
The [schema-v3 evidence](evidence/qa-002-20260828.md) remains historical
diagnostic evidence only.

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

## Initial Exact-Source Continuous Integration

Main CI run
[33137517161](https://github.com/chenrgSix/AgentRoom/actions/runs/33137517161)
passed on exact commit `9af9edae36ed5fce2cf5b3b2ef06a7cfd91b8d4b`.
Repository, Go, native macOS Desktop, and native Windows Desktop jobs passed
locked dependency installation, contract generation and validation, production
builds, workspace tests, deterministic cross-process E2E, documentation and
patch checks, real Compose/Caddy configuration validation, full Go tests and
vet, four-platform Central packaging, and native Desktop package smoke checks.

## Initial Protected Release Workflow

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

## Initial Independent Public Asset Verification

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

## Follow-up Exact Candidate

Main CI run
[33153187121](https://github.com/chenrgSix/AgentRoom/actions/runs/33153187121)
passed Repository, Go, native macOS Desktop, and native Windows Desktop jobs on
exact commit `17ae30ee2331ac37fb2dafeb7ee0fa2bd7e9f661`. Annotated tag
`v0.4.0-qa030.2` resolves to that commit.

Release run
[33153445742](https://github.com/chenrgSix/AgentRoom/actions/runs/33153445742)
validated the empty Draft, tested the tagged Bridge, built the complete native
matrix, verified exactly 22 assets before upload, and downloaded and verified
the Draft assets again. The native Windows job passed Desktop tests plus the
current-user installer checks. The Windows Desktop portable ZIP has SHA-256
`4aa85b5550ac82eabad4d5dda8d7b7b4ec70663e07da3b650fd7482eb0a1beec`;
the Windows installer has SHA-256
`099f2491251b7b2c2ae92b4f9c055037172ecf80f6db9b83bc8b6d9bebb61a64`.

The Draft was published as the
[v0.4.0-qa030.2 prerelease](https://github.com/chenrgSix/AgentRoom/releases/tag/v0.4.0-qa030.2)
at `2026-08-28T08:10:02Z`. Stable Latest remains `v0.2.0`. A fresh directory at
`/private/tmp/agentroom-qa0302-public.pr5Opw` then downloaded every public asset
with ordinary `curl` and no authorization header. One transient TLS fetch was
retried; the final complete set passed the tag's committed verifier:

```text
Verified 4 checksum-pinned Central release archives for v0.4.0-qa030.2
Verified 22 release assets for v0.4.0-qa030.2
```

This follow-up candidate contains `RUN-013` terminal-Delivery metric fencing and
`CON-015` independent current-Bridge build observation, including Central
schema version 48. Package evidence does not assert that the physical Windows
Device has installed or reported the new build.

The first physical Central upgrade rehearsal exposed a lifecycle preflight
gap recorded by [OPS-010](ops-010-lifecycle-secret-preflight.md): a corrupted
zero-byte recovery source passed the released `doctor`, and the released
`upgrade` reached container replacement before `secret-init` rejected it. The
old revision was restored with the exact retained authority and remained
healthy, but this failed rehearsal cannot be promoted to upgrade evidence.
`v0.4.0-qa030.2` therefore remains valid package evidence only; a follow-up
exact candidate containing `OPS-010` is required for the physical closure run.

## Lifecycle-Safe Exact Candidate

Main CI run
[33156064179](https://github.com/chenrgSix/AgentRoom/actions/runs/33156064179)
passed Repository, Go, native macOS Desktop and native Windows Desktop jobs on
exact release-preparation commit
`1b24b0c55c7f70236a66d60fe16362c6e3213b3e`. Annotated tag
`v0.4.0-qa030.3` resolves to that commit.

Release run
[33156486627](https://github.com/chenrgSix/AgentRoom/actions/runs/33156486627)
validated an empty Draft, tested the tagged Bridge, built the complete native
matrix, passed the Windows current-user install/upgrade/uninstall and owner
state smoke checks, verified exactly 22 assets before upload, and downloaded
and verified the Draft assets again. The Windows Desktop portable ZIP has
SHA-256
`d7a4bcf8651ea8e45d0b915bd610b21319713b0d542743e64c8d75f0feb40ac6`;
the Windows installer has SHA-256
`19a1815660dc98f43b1ea61e55e5e5c966521f58b464b60d844db37b60d53222`.

The Draft was published as the
[v0.4.0-qa030.3 prerelease](https://github.com/chenrgSix/AgentRoom/releases/tag/v0.4.0-qa030.3)
at `2026-08-28T08:50:07Z`; stable Latest remains `v0.2.0`. A fresh directory
downloaded every asset with ordinary unauthenticated `curl` from the public
Release URL. The tag's committed verifier reported:

```text
Verified 4 checksum-pinned Central release archives for v0.4.0-qa030.3
Verified 22 release assets for v0.4.0-qa030.3
```

The physical macOS Central then consumed the independently published Darwin
arm64 internal checksum pin, created a verified SQLite backup, and upgraded
from `v0.4.0-qa030.1` to `v0.4.0-qa030.3`. The controller retained the same
installation identity, private CA and trust epoch; the manifest reports schema
48 and `ready`, while `doctor` passes HTTPS and WebSocket readiness. The same
Windows Device reconnected without another pairing and still reported its old
Bridge `0.4.0-qa030.1`, proving Central rolling compatibility but not the
required Bridge package upgrade. Two managed Agents were ready, and packaged
metrics reported one authenticated Bridge, queue depth zero, pending Delivery
count zero and four completed Runs.

## Provisional Physical Record and Audit Correction

The [schema-v3 record](evidence/qa-002-20260828.md) captured the intended
physical boundary on the accepted `private_scoped_ca` profile. The
physical Windows Device installed the exact published `v0.4.0-qa030.3`
current-user installer in place; its digest matched the release and Central's
authenticated hello observed the new version without another pairing. The
then-canonical installed deep link and matching phrase were used, and the operator
confirmed there was no OS CA import, leaf pin, TLS-verification bypass, Server
Token copy, Device credential copy, manual `.env`, or OpenSSL step.

The verifier did not, however, bind those human facts, selected Runs, heartbeat
and metrics capture to the current Bridge observation in one bounded UTC
window. The record therefore does not close `QA-030`. The historical manual-CA
diagnostic remains advanced compatibility evidence only. Deterministic and
Caddy tests separately retain the `public_ca` default/no-silent-fallback
boundary while fresh schema-v4 physical evidence, including the installed
canonical `convenewire://` launch rather than legacy `agentroom://`
compatibility, remains required for the scoped-private alternative.

## Schema-v4 physical closure

The exact `v0.4.1-qa035.1` candidate at commit
`152892e59e90fe17799274009141b07714262378` passed main CI run `33294027654`
and protected Draft Release workflow run `33294193123`. The physical record
binds that Central and Windows Bridge build to the canonical
`convenewire://` launch and `private_scoped_ca` descriptor. The operator
reviewed and confirmed that Windows received no OS CA import, application TLS
verification was not bypassed, and no Server Token, Device credential, manual
`.env`, or OpenSSL step was used. This completes the scoped-private half while
the deterministic deployment matrix remains authority for the public-CA
default and no-silent-fallback half.
