# OPS-013 Immutable Central Images Acceptance

- Date: 2026-08-30
- Scope: deterministic local implementation and real Docker evidence
- Result: PASS

## Boundary under test

One resolved Release source commit produces one OCI bundle per Linux
architecture. The bundle contains exactly the Server and Caddy runtime images,
binds both their OCI manifest digests and Docker config image IDs, derives one
strict Docker-save projection from the same configs and ordered layers, binds
their Release/source/platform labels, and carries a pinned-generator SPDX SBOM
plus source-bound SLSA provenance. Central archives embed the matching
same-architecture bundle. After load, the controller activates one complete
store-supported Server/Caddy pair and persists that generation before rendering
Compose, without a target-host build or registry fallback.

This record closes the repository implementation task. Follow-up `QA-034`
hosted evidence now publishes and executes both Linux architectures; this
record still does not install a Central archive on a target host or close
`QA-035` or `QA-036`.

## Current dual-store exact-commit evidence

- Source commit: `72042832c87bd13d966188018f14e63bed65af66`
- Candidate identity: `v0.4.1-qa034.2`
- Platform under execution: `linux/arm64`
- Archive SHA-256:
  `558e2f253df89c4a884335c9b2a93dd9bfa167d4ec1b546230fd5041d14cbfdc`
- Server OCI manifest:
  `sha256:422aa9ea8b9c567bb25e08062a053f0b89acd72de80a49520a0936b1bd4bf3ef`
- Server config image ID:
  `sha256:7c76039111cb8096773ea7315aab756275fde5a2f61eacb422010683ef892c5f`
- Caddy OCI manifest:
  `sha256:5859d734243d1dab0dd1b2e41f96682fae2ebba1f5b78c541ad1aa7f52b5f86d`
- Caddy config image ID:
  `sha256:96663390a7ee4b6e6605ab8b626c00e6178614b7b7e503dcc5ea745acf369878`

One exact archive was verified from an absent-candidate boundary in both image
stores:

- Docker Engine `29.4.0` with
  `io.containerd.snapshotter.v1` selected the two repository-qualified OCI
  manifest references and returned:

  ```text
  Verified clean-daemon OCI load, default Server readiness/build identity, and containerd-manifest-digest execution for linux/arm64
  ```

- An isolated Docker Engine `28.0.4` daemon with classic `overlay2` selected
  the two config image IDs and returned:

  ```text
  Verified clean-daemon OCI load, default Server readiness/build identity, and classic-config-digest execution for linux/arm64
  ```

Both runs loaded only the archive identified above, retained one whole
Server/Caddy reference generation, and executed with `--pull=never`. The Server
used its image-default command, applied migrations, reached readiness, and
emitted the exact candidate/source build identity. Caddy executed from the same
selected generation. Partial, mixed, missing, or wrong-ID generations fail
before runtime execution in the verifier and controller regressions.

Controller recovery tests additionally prove that a failed install selection
CAS writes no configuration and that a failed upgrade-journal generation bind
starts no target service; exact retry converges without repeating the verified
backup. The controller and release-image suites pass under the race detector,
and deterministic cross-process E2E passes with five scenarios and one explicit
live-Runtime skip.

## Prior manifest-only real-Docker evidence

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

The prior build ran from a clean worktree with `SOURCE_REF=HEAD`, the exact source
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
  jobs to consume its matching once-built architecture artifact.
- `QA-034` Release run `33287755768` supplied the separate hosted evidence:
  both `linux/amd64` and `linux/arm64` clean-daemon image executions passed and
  all four schema-v2 Central archives consumed their matching verified
  architecture artifact before the closed 22-asset upload.

## Remaining admission evidence

1. `QA-035` must install and execute a candidate Central archive and match its
   live build identity; the hosted native Windows upgrade gate passed
   separately in Release run `33287755768`.
2. `QA-036` still depends on the remaining target-host and physical results,
   native Windows Job Object
   execution, and the fresh two-physical-machine schema-v4 record.
