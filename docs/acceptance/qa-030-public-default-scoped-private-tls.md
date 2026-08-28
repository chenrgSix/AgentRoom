# QA-030 Public-Default and Scoped-Private TLS

Date: 2026-08-28

Source commit: `98fc9c4480759375cea8d4cce12f757f68a025b8`

Status: `ACTIVE` — deterministic and local package gates pass; the required
clean two-physical-host release rehearsal has not run.

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

## Remaining Physical Gate

`QA-030` is not `DONE`. A new exact tag containing commit `98fc9c4` or a later
reviewed descendant must pass the protected Release workflow, including native
Windows Bridge desktop/installer assets. Then two distinct physical hosts must
perform one clean run with either:

- `public_ca`, verified only by the Bridge host system trust store; or
- `private_scoped_ca`, bootstrapped from the exact pairing link and retained
  only in Bridge owner state.

The reviewed record must confirm no CA was installed into the Bridge host OS,
no leaf fingerprint or Server Token was copied, no TLS verification was
disabled, the installed deep link opened, the verification phrase matched, and
the same Device completed online plus offline/reconnect work. Until that record
exists, `QA-002` and `QA-028` remain blocked and the old manual-CA diagnostic
cannot be promoted.
