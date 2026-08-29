# OPS-013 Immutable Central Images Acceptance

- Date: 2026-08-30
- Scope: deterministic local implementation and real Docker evidence
- Result: PASS

## Boundary under test

One resolved Release source commit produces one OCI bundle per Linux
architecture. The bundle contains exactly the Server and Caddy runtime images,
addresses both by manifest digest, binds their Release/source/platform labels,
and carries a pinned-generator SPDX SBOM plus source-bound SLSA provenance.
Central archives embed the matching same-architecture bundle, while the
controller loads and activates only the recorded digest references without a
target-host build or registry fallback.

This record closes the repository implementation task. It does not publish a
Release, substitute arm64 execution for hosted amd64 execution, install a
Central archive on a target host, or close `QA-034`, `QA-035`, or `QA-036`.

## Exact real-Docker evidence

- Source commit: `5b3f31ed2389da61846c2f689b81c4055c4813ba`
- Synthetic Release identity: `v0.0.0-final.1`; no tag or Release was created
- Docker Engine: `29.4.0`, `linux/arm64`
- Platform under execution: `linux/arm64`
- Archive SHA-256:
  `f1474e692f2eb766eb150818a8de9a56b88bcb7cbcf8492e96c50f9f6a3b3216`
- Server manifest:
  `sha256:0c32523adc5e8a5e86fab7cf275ac0b36d8fd7b7d84947dc79fa88c2539b50f6`
- Caddy manifest:
  `sha256:793c3ecc342c223c58176500941728b790186f2ef5041105b9d8cd84b5be52fb`
- SBOM generator:
  `docker.io/docker/buildkit-syft-scanner@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9`

The build ran from a clean worktree with `SOURCE_REF=HEAD`, the exact source
commit above, the pinned scanner, and local builder/invocation identities. The
Docker verifier began with both new digest references absent, checked the
archive digest and metadata, loaded only that bundle, and returned:

```text
Verified clean-daemon OCI load, default Server readiness/build identity, and digest-only execution for linux/arm64
```

The Server ran with its image-default
`["node","apps/server/dist/server.js"]` command, no network, a read-only root,
all capabilities dropped and `--pull=never`. It applied migrations, reached
`/api/health/ready`, and emitted exactly the expected Release/source pair from
`/api/metrics`. Caddy executed from its digest reference with no network, a
read-only root and `--pull=never`.

## Defect found by the real gate

The first real execution loaded both images and proved Server readiness, then
failed because the verifier invoked `version` as though the upstream Caddy
image declared an Entrypoint. Its config instead declares the full Caddy
invocation in `Cmd`, so overriding the command must explicitly run
`caddy version`. Commit `5b3f31e` corrected the verifier and added a Release
policy regression that rejects the broken invocation shape. The exact-commit
bundle was rebuilt and the complete gate then passed.

## Structural and deterministic evidence

- release-image Go tests mutate descriptors, blobs, labels, SBOMs,
  provenance, metadata, duplicate/unreferenced content and platform identity;
- controller tests cover digest-only install/upgrade, runtime drift, backup
  receipts and upgrade-journal recovery under the race detector;
- workflow policy tests require exact-SHA full gates, one once-built image
  artifact per architecture, the pinned scanner and the clean-daemon verifier;
- workflow policy tests also require each of the four schema-v2 Central archive
  jobs to consume its matching once-built architecture artifact. Actual amd64
  image execution and all four schema-v2 archive builds remain `QA-034` hosted
  evidence rather than a result inferred from that static wiring check.

## Remaining admission evidence

1. `QA-034` must run the complete protected workflow against one synthetic
   empty Draft Release.
2. `QA-035` must install and execute a candidate Central archive and match its
   live build identity, alongside the hosted native Windows upgrade gate.
3. `QA-036` still depends on those hosted results, native Windows Job Object
   execution, and the fresh two-physical-machine schema-v4 record.
