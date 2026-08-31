# REPO-004 Retained Commit Bundle Producer

Date: 2026-09-01. Scope: local capture-owned Git bundle production and real Git
consumer verification. This increment does not complete REPO-004 or the governed
software-team lifecycle. Delivery status remains solely in TASKS.

## Implemented Boundary

`ReadCapturedCommitBundle` validates the existing capture, intent, prepared
repository, private object-store identity/configuration and candidate before
producing standard Git bundle v3 bytes. The sole advertised ref names the exact
candidate, and the sole prerequisite is its prepared output base. When upstream
patches produced a synthetic prepared commit, the consumer must possess that
exact commit; the original repository base is insufficient.

The producer uses Git's incremental bundle format rather than copying a checkout
or inventing a base64 JSON wrapper. Its fixed prerequisite comment removes the
source commit subject. Envelope validation restricts version, object format,
prerequisite and candidate ref, verifies the pack trailer, and enforces the
existing 4-MiB Artifact bound. These are envelope checks, not a replacement for
Git's object and ancestry validation. The format follows the primary
[Git bundle documentation](https://git-scm.com/docs/git-bundle) and
[bundle format specification](https://git-scm.com/docs/gitformat-bundle).

An immutable local receipt records capture identity, prerequisite, format,
content SHA-256 and length. After the receipt exists, replay returns the stored
bytes instead of depending on later compression or Git-version changes. A crash
after installing content but before recording the receipt can recover only if
the newly computed bytes match; a conflict never overwrites retained data.
Later live edits and exact worktree retirement do not change the sealed bundle.

## Focused Evidence and Review

Six top-level tests with 20 named subcases cover:

- Real SHA-1 and SHA-256 captures, with and without upstream inputs. Separate
  repositories run `git bundle verify`, `git bundle unbundle` and strict fsck;
  candidate, parent, tree and changed-file bytes match and target refs do not move.
- Actual transmitted-pack inspection verifies the candidate is present while
  unchanged private blobs and prerequisite commits are absent. Incremental
  bundles are thin packs; inspection repairs them against receiver-owned bases
  and excludes those appended bases from transmitted-object accounting.
- A consumer holding only the original base rejects a prepared-input bundle.
  A zero-code-delta capture still has an actual commit object without copying
  the unchanged tree. Neither case fabricates commit content from metadata.
- Retention survives owner reopen, content-before-receipt interruption and
  checkpoint-driven exact cleanup. Live file bytes are checked before and after
  later edits, not merely by comparing Git status categories.
- Changed bytes, missing content, conflicting partial writes, receipt/capture
  identity, capture ref and private Git configuration fail closed. Additional
  refs/capabilities, changed format/prerequisite/candidate, version and checksum
  also fail. A synthetic checksummed pack exercises only the independent size
  bound; real Git consumers establish object validity.

The shared sealed-source validation was extracted from report publication
without widening its source selection or supported output kinds.

## Validation Record

Locally verified on macOS arm64 with Node 22.23.1, Go 1.26.7 and Apple Git 2.50.1:

- Full Bridge tests: 349 passing top-level tests across 24 tested packages,
  including the six new producer tests. Five opt-in process helpers skip as
  standalone entries; the operations package has no test files.
- Repository and Artifact race checks pass. The unchanged actual Go/Server/Git
  publication fixture passes five Node cases covering its existing patch/report
  transports and response-loss/restart scenarios, not commit transport.
- Full Bridge vet, native CLI build and Windows/Linux amd64 repository-test
  cross-compilation pass. The cross-compiled binaries were not executed on
  physical Windows/Linux machines. Focused producer tests pass again after
  strengthening the live-file preservation assertions.
- Markdown lint checks 306 maintained files with no issues; whitespace checks
  pass. No wire, Server behavior, UI or remote-provider changes are in this
  producer increment, and their broader acceptance is not inferred.

## Remaining Authority and Delivery

This API returns local bytes only. It does not create a canonical commit Artifact,
extend the wire media-type allowlist, import a dependency into an actual governed
Run, start a Runtime, verify Task acceptance or move an integration target.
The cleanup test uses the existing explicit fixture stopped-Run authority, not
production authorization. Canonical transport and compatibility/migration tests
remain required before closing REPO-004. BRG-071, RUN-018, VER-001, complete input
gates, parallel integration, browser flows, autonomy and final audit remain
separate required product gates.
