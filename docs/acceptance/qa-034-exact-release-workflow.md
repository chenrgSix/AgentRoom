# QA-034 Exact-Source Release Workflow Acceptance

## Result

- Date: 2026-08-30
- Status: `DONE`
- Release tag: `v0.4.1-qa034.4`
- Release source: `75afb5b7d2591c2aad3c514552f737532b0af94d`
- Published prerelease:
  <https://github.com/chenrgSix/ConveneWire/releases/tag/v0.4.1-qa034.4>

This record closes the exact-source hosted Release workflow owned by `QA-034`.
It does not install a Central archive on a target host, replace the fresh
schema-v4 two-physical-machine record, or close `QA-035` or `QA-036`.

## Exact source and complete gates

Annotated tag `v0.4.1-qa034.4` has tag object
`0a8a23bcd824a8215b9dc9c9b7c07659689709f0` and peels to the exact Release
source above. Main [CI run 33287636198](https://github.com/chenrgSix/ConveneWire/actions/runs/33287636198)
passed Repository, Go, native macOS Desktop, and native Windows Desktop jobs on
that commit before publication.

An empty prerelease Draft was then supplied to
[Release run 33287755768](https://github.com/chenrgSix/ConveneWire/actions/runs/33287755768).
All 19 jobs passed on the same resolved source: Draft validation, complete
Repository and Go release gates, five Bridge CLI builds, three Desktop builds,
two architecture-specific Central OCI builds, four Central archive builds,
asset attachment, and downloaded-Release verification. The workflow rechecked
the tag before attachment and again before downloaded-Release verification.

Both `linux/amd64` and `linux/arm64` Central OCI jobs loaded the once-built
Server/Caddy pair into a clean daemon and executed readiness, exact build
identity, default Server command, and Caddy checks. Each of the four Central
archives consumed its matching verified architecture artifact. The hosted
native Windows job independently downloaded stable `v0.4.0`, upgraded it to
the candidate, and passed installed/staging/ZIP executable equality, protocol
registration, owner-state preservation, uninstall, and digest checks. This
closes the hosted Windows portion of `QA-035`, but not its target-host Central
or physical schema-v4 gates.

## Closed asset set and public verification

The committed verifier accepted exactly 22 assets before upload and after
downloading the Draft again:

- five Bridge CLI archives;
- two macOS Desktop archives, one Windows Desktop ZIP, and one Windows
  current-user installer;
- four Central archives and their four separate internal-checksum pins;
- `SHA256SUMS`; and
- `LICENSE`, `NOTICE`, `COMMERCIAL-LICENSE.md`, and `TRADEMARKS.md`.

The Draft was published at `2026-08-30T02:32:32Z` as a prerelease. A separate
anonymous GitHub API request then reported `draft=false`, `prerelease=true`,
and exactly 22 public assets. A clean temporary directory downloaded the public
Windows installer and `SHA256SUMS` without a GitHub credential. The downloaded
installer entry and independently computed digest matched:

```text
72239c0cecb27a73ba01710be2f445293479aea75b476573015b5d9e00e5958d  convenewire-bridge-desktop_0.4.1-qa034.4_windows_amd64_setup.exe
```

The installer is 6,051,850 bytes. The public `SHA256SUMS` file has SHA-256
`0a2ff14f7cb5b2b52dc2af0c3fbc0a068292b730099cfcebdd40ca2acec767eb`.
The public Latest endpoint still resolves to stable `v0.4.0`; this candidate
did not replace it.

## Failed-closed history

Candidates `v0.4.1-qa034.1`, `v0.4.1-qa034.2`, and `v0.4.1-qa034.3` remain
unpublished prerelease Drafts with zero assets. They preserve evidence that an
unsupported Docker load path, unprivileged runtime cleanup, and a cross-target
host-tool execution error each stopped the workflow before attachment. The
superseding `.4` tag is immutable and contains the focused regressions for
those failures.
