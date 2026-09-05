# QA-063 Streamlined Release Workflow

Status: accepted and published on 2026-09-05. The Owner-authorized
`v0.5.0-rc.6` transition-release goal was frozen before tag, Draft or
publication. Delivery state lives only in `docs/TASKS.md`.

## Goal

Implement ADR-0041 without rewriting any historical Release:

- publish standalone Bridge CLI archives only for Linux amd64 and arm64;
- publish Bridge Desktop only for Apple-silicon macOS and 64-bit Windows;
- keep advanced client commands inside each Desktop package as a same-source,
  same-version CLI helper;
- replace the default Central OCI/archive matrix with one exact-source,
  checksum-closed source archive; and
- require exactly 12 named assets at the future Release boundary.

## Frozen v0.5.0-rc.6 Candidate

The Owner authorized `v0.5.0-rc.6` on 2026-09-05 as the first real transition
candidate for the ADR-0041 distribution boundary. It supersedes
`v0.5.0-rc.5` for evaluation without moving, rewriting, deleting or relabeling
any older tag, Release or asset. Stable GitHub Latest remains `v0.4.2`.

The candidate contains both the streamlined 12-asset Release implementation
and the accepted Discussion integrity work in `DISC-013` and `DISC-014`. It is
not a stable-release admission and does not close `QA-060`.

The exact source commit is selected only after this frozen record and the
release notes are committed on clean `main`, local `main` equals
`origin/main`, and that exact commit passes the complete main CI. The
authorization permits an annotated tag and empty Draft only for that selected
commit. Public prerelease publication remains gated on the protected tagged
workflow, authenticated closed-set verification and the supported physical
Central source-package installation in this record. Independent anonymous
download verification follows publication immediately; a failure there leaves
the immutable prerelease published but keeps `QA-063` unaccepted.

## Implemented Source

- `9431264` accepted ADR-0041 and froze the distribution boundary.
- `f03139e` limited standalone Bridge packaging to Linux, limited macOS Desktop
  to arm64 and added the bundled macOS/Windows CLI helpers plus installer
  ownership.
- `e24ba0d` added the closed Central source layout, schema-3 release metadata,
  three host controller helpers, host dispatcher, source-package verifier and
  source-build lifecycle identity checks.
- `e14413a` added physical source-package tamper rejection.
- `612fd94` removed the default Central OCI and Intel-macOS Release jobs,
  reduced the standalone CLI matrix to Linux, changed CI to one Central source
  package and changed the combined verifier to the 12-asset closure.
- `27bfc7c` made the Windows upgrade verifier preserve compatibility with the
  previous stable installer while requiring and digest-checking the bundled CLI
  helper after the candidate upgrade.

The prior OCI builder, Docker verifier, schema-2 controller support and
historical acceptance records remain in the repository as optional and
compatibility machinery. They are not invoked by the default Release graph.

## Local Evidence

- The Release policy suite passes 23 tests. Its negative cases reject a
  restored `central-image` job, Central matrix/OCI inputs, Darwin or Windows
  standalone CLI entries, Intel macOS Desktop and retired checksum entries.
- Bridge output-path policy passes 3 tests. Full Bridge, Desktop-tag, controller
  test/vet/build and Compose/Caddy checks passed while implementing the owning
  commits.
- The Central package tamper regression builds a real source archive, verifies
  all three helper architectures, changes packaged `package.json` without
  updating either checksum layer and proves verification rejects it.
- A physical `v0.0.0-qa063` run from exact commit `612fd94` generated Linux
  amd64/arm64 CLI archives, the native Apple-silicon Desktop archive and the
  Central source archive plus pin in one owned root. The Central verifier
  passed, five locally buildable artifacts were present, and
  `/private/tmp/convenewire-streamlined-release.MIUrGQ` was physically absent
  after the runner exited.
- Shell syntax and `git diff --check` pass for the current packaging and policy
  files.
- Exact commit `9326967` passes 14-schema/258-fixture validation, all workspace
  production builds and the complete `npm test` aggregate, including 598 Server
  tests, Web tests, Bridge UI, QA evidence, product-experience, site and 25
  temporary-lifecycle checks. Its owned outer root
  `/private/tmp/convene-wire-test-run-mDRPMO` was physically absent after exit.
  The separately running product-preview root was observed open by its live Node
  processes and was neither classified as residue nor removed by this task.

## Native Windows Evidence

Main CI run `33866803801` against exact commit `196b4a8` first proved that the
candidate installer compiled both `ConveneWire Bridge.exe` and
`convenewire-bridge.exe`, then failed closed while inspecting the installed
previous stable `v0.4.2`: the verifier had incorrectly imposed the newly added
helper on that historical package before performing the upgrade.

Exact commit `27bfc7c` separates those lifecycle assertions explicitly. Main CI
run `33867235971`, including native Windows job `101004829330`, passes the
previous-stable install, owner-state fixture, in-place candidate upgrade,
candidate GUI/helper version and digest checks, icon/shortcut/protocol and
uninstaller checks, owner-state preservation and managed-payload removal. The
same run also passes the repository, Go/Central and native Apple-silicon jobs.

## Tagged Release Acceptance

`BRG-075` is complete. Its final evidence comes from the native Windows runner,
not cross-compilation: both candidate executables are inspected, the historical
stable package remains a valid upgrade source, the new helper appears after the
candidate upgrade, and uninstall removes both managed executables without
removing the retained owner-state fixture.

Annotated tag `v0.5.0-rc.6` has tag object
`bbcce3098caa16132fa155c7e33f95a3b145db4d` and peels to exact commit
`6349571870df16e753a4397644a0e4f4eff003ed`. The clean local `main` equaled
`origin/main` at selection. Exact-source main CI run
[33940607248](https://github.com/chenrgSix/ConveneWire/actions/runs/33940607248)
passed Repository, Go, native Apple-silicon macOS and native Windows on its
first attempt.

Protected Release run
[33940981997](https://github.com/chenrgSix/ConveneWire/actions/runs/33940981997)
passed all 10 executions without retry:

- validate Draft `101238231076`, Repository `101238245277` and Go
  `101238245375`;
- Central source `101239263919`, Linux amd64 `101239263933`, Linux arm64
  `101239263953`, macOS arm64 Desktop `101239264000` and native Windows
  Desktop/installer `101239263920`; and
- attach `101239526964` and authenticated Draft-download verification
  `101239558040`.

The native Windows job installed stable `v0.4.2`, upgraded to rc.6, required
the candidate GUI and bundled CLI helper, preserved representative Owner state
and removed both managed executables on uninstall. The publish job accepted
the 12-asset set before upload, and the verifier accepted a new authenticated
Draft download afterward. A second task-owned authenticated download on the
physical macOS host also passed the exact tagged verifier.

## Physical Central Source Installation

The physical Apple-silicon macOS host used Docker Engine `29.4.0` and Compose
`v5.1.2`. It downloaded and verified the Draft Central source archive and its
separate internal-checksum pin, extracted it unchanged and observed the
packaged launcher report `v0.5.0-rc.6`.

`convenewirectl install` then built Server/Web through Docker Compose under a
task-only project, data root and loopback ports. `status` reported release
`v0.5.0-rc.6`, source
`6349571870df16e753a4397644a0e4f4eff003ed`, step `ready` and a healthy Server;
the running Server image carried the same version and revision labels.
`doctor` returned `PASS` for release checksums, private files, the Compose
model, browser readiness, HTTPS readiness and WebSocket ingress.

Before uninstall, the SQLite file was mode `0600`, inode `78244885`, size
`2908160`; the Owner recovery file was mode `0600`, inode `78244840`, size
`65`. Non-purging uninstall preserved both identities and advanced the
mode-`0600` manifest to `uninstalled`. No task Compose container or listener
remained, and the exact acceptance root was physically absent after cleanup.
Pre-existing unrelated containers and historical temporary-prefix entries were
unchanged and were not removed.

## Publication And Independent Download

The Draft was published as a prerelease at `2026-09-05T03:21:50Z`. It exposes
exactly 12 assets totaling `49106801` bytes; the public `SHA256SUMS` digest is
`4efcaac201e20c9ee611119a263bb70bc6f12c5ac34cfbce58b09d12749449c4`.
The Release page returned HTTP 200, while public `/releases/latest` continued
to return HTTP 200 at stable `v0.4.2`.

The first credential-free attempt to enumerate assets through the public
GitHub API received HTTP 403 rate limiting before creating any file. It did not
retry a mutation or validate a partial set. A fresh task-owned directory then
downloaded all 12 frozen public asset URLs directly without GitHub credentials;
the same tagged verifier accepted every checksum, archive, executable, bundled
helper, license file and Central source closure. That public-download root was
physically removed afterward.

**Decision: PASS.** `v0.5.0-rc.6` is accepted and published as the first
ADR-0041 transition candidate. Windows signing/notarization, Intel macOS, an
offline OCI bundle, stable `v0.5.0`, the stable backup/upgrade/rollback smoke,
multiple physical execution machines and a live Remote Provider remain outside
this acceptance.
