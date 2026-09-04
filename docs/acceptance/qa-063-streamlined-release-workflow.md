# QA-063 Streamlined Release Workflow

Status: implementation and native Windows lifecycle accepted; tagged hosted
Release and physical Central installation evidence remain open. Delivery state
lives only in `docs/TASKS.md`.

## Goal

Implement ADR-0041 without rewriting any historical Release:

- publish standalone Bridge CLI archives only for Linux amd64 and arm64;
- publish Bridge Desktop only for Apple-silicon macOS and 64-bit Windows;
- keep advanced client commands inside each Desktop package as a same-source,
  same-version CLI helper;
- replace the default Central OCI/archive matrix with one exact-source,
  checksum-closed source archive; and
- require exactly 12 named assets at the future Release boundary.

This record does not authorize a tag, Draft or publication.

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

## Open Admission Evidence

`BRG-075` is complete. Its final evidence comes from the native Windows runner,
not cross-compilation: both candidate executables are inspected, the historical
stable package remains a valid upgrade source, the new helper appears after the
candidate upgrade, and uninstall removes both managed executables without
removing the retained owner-state fixture.

`QA-063` remains active until an exact tagged candidate supplies:

1. passing repository, Go, two-way Linux CLI, native Apple-silicon Desktop,
   native Windows Desktop/installer, single Central source, publish and
   post-download verification execution;
2. exactly 12 authenticated Draft assets accepted by the tagged combined
   verifier, with no retired top-level assets;
3. a clean independent download accepted by the same verifier; and
4. one supported physical Central host building and starting the verified
   source package through `convenewirectl`, reporting the exact Release/source
   identity and leaving its owned acceptance root absent after cleanup.

Windows signing/notarization, Intel macOS, an offline OCI bundle and Release
publication are not inferred from this implementation record.
