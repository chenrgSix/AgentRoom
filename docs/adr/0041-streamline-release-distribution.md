# ADR-0041: Streamline release distribution

- Status: Accepted
- Date: 2026-09-04
- Supersedes: none
- Amends: ADR-0029 and OPS-013 distribution guidance

## Context

The current Release workflow publishes five standalone Bridge CLI archives,
three Desktop archives, one Windows installer, four host-specific Central
archives, four Central checksum pins, licenses, and an outer checksum file.
Two architecture-specific Central OCI bundles are built and executed before
those four Central archives are assembled. This produces a closed and strongly
verified Release, but the default candidate has 22 assets and 19 workflow jobs.

The product no longer needs every historical distribution shape as an ordinary
download. macOS and Windows users enter through Bridge Desktop. Current macOS
product support is Apple silicon. Standalone Bridge is still valuable on Linux
servers and headless workstations. Central operators can build Server/Web from
an exact, checksum-closed source bundle with Docker Compose instead of receiving
the same large prebuilt OCI bundle repeated in four host archives.

Removing the standalone macOS and Windows CLI downloads must not remove the
owner-local Artifact, Result, repository, grant, verifier, integration, or
cleanup commands that are not yet represented in the Desktop UI. Replacing the
Central archives must not discard the existing controller's install, recovery,
backup, upgrade, trust, or non-purging uninstall boundaries.

## Decision

### Bridge packages

New Releases publish these Bridge products:

- standalone CLI archives for `linux/amd64` and `linux/arm64` only;
- one unsigned macOS Desktop archive for `darwin/arm64` only; and
- one unsigned Windows Desktop archive and current-user installer for
  `windows/amd64`.

The macOS and Windows Desktop payloads include a same-source, same-version
`convenewire-bridge` CLI helper. It is not a separate top-level Release asset.
The helper preserves advanced local-owner and automation commands while the
Desktop application remains the ordinary entry point. Package verification
checks both binaries' version, source commit, architecture, and placement. The
Windows installer owns and removes both executables.

The macOS minimum system version remains the compiled and declared deployment
target owned by BRG-067. This decision removes Intel packaging; it does not
silently raise the arm64 operating-system minimum.

### Central package

New Releases publish one host-neutral
`convenewire-central_<version>_source.tar.gz` plus one checksum-manifest pin.
The curated archive, rather than GitHub's automatic repository snapshot,
contains only the exact deployment source and files required to build and
operate Central:

- Server, Web, Contracts, Dockerfile, Compose, Caddy profiles, locked package
  metadata, backup/restore scripts, and license material;
- closed release metadata containing the exact Release version, source commit,
  and current database schema;
- prebuilt, checksum-covered `convenewirectl` helpers for supported Central
  hosts (`linux/amd64`, `linux/arm64`, and `darwin/arm64`) plus one dispatching
  wrapper; and
- an exhaustive internal `SHA256SUMS` whose digest is separately published and
  also covered by the outer Release checksum.

The controller verifies the source archive before invoking Compose. Install and
upgrade build the Server image locally from that exact context with the Release
version and source commit as Docker build arguments. The Node base and Caddy
images remain digest-pinned. Runtime readiness must report the same build
identity; a source build is not accepted merely because containers are up.

The default Release no longer embeds or publishes an offline Central OCI
bundle. A deployment therefore needs Docker with Compose and network access to
obtain any digest-pinned base images not already present. Offline bundles remain
an optional operator extension and require a separately approved Release task.

### Release closure

The default closed set becomes 12 assets:

1. two Linux Bridge CLI archives;
2. macOS arm64 Desktop archive;
3. Windows amd64 Desktop archive and installer;
4. one Central source archive and its internal-checksum pin;
5. four top-level license files; and
6. one outer `SHA256SUMS`.

The workflow continues to resolve one immutable tag commit, require an empty
Draft Release, run repository and native-platform gates, verify the complete
asset set before upload, download it again, and repeat the same verifier. Old
Release assets and their historical acceptance evidence remain immutable.

## Ownership

| Fact or operation | Authority |
| --- | --- |
| Desktop application and bundled local CLI helper | Bridge package |
| repository paths, Git credentials and Git commands | Client/Bridge owner |
| curated Central source and closed package metadata | Release workflow |
| target-host Central source build and Docker state | installation operator |
| install, backup, upgrade, trust migration and uninstall sequencing | `convenewirectl` |
| Team, Plan, evidence and scheduling state | Central Server |

Central source packaging does not grant Central repository or Git authority.
Bridge helper bundling does not let Desktop infer or broaden an Owner grant.

## Alternatives

- Keep all 22 assets: rejected as the ordinary path because it repeats products
  users do not select and makes each Release expensive to build and inspect.
- Remove macOS/Windows CLI functionality entirely: rejected because Desktop
  does not yet expose every owner-local governed-repository operation.
- Publish GitHub's automatic source archive: rejected because it has no curated
  file closure, release metadata, internal checksum pin, or supported lifecycle
  helper contract.
- Ship only raw Compose files: rejected because it would bypass the established
  checksum, backup, upgrade, trust, recovery, and non-purging uninstall owner.
- Keep offline OCI bundles in every default Release: deferred as an optional
  distribution extension rather than a Core installation requirement.

## Consequences

Release fan-out and total asset size fall substantially. macOS Intel and
standalone macOS/Windows CLI downloads are no longer produced after the first
Release implementing this ADR. Advanced client commands remain available
inside Desktop packages. Central installation takes longer and requires local
Docker build capacity and base-image availability, but downloads one portable
source package and retains controlled lifecycle operations.

Existing installations and old Release packages are not rewritten. Moving an
existing image-backed installation to a source-build Release remains an
explicit, checksum-pinned, backup-first controller upgrade.

## Compatibility and Security

Wire, database, Team, Device, Plan, evidence, repository, and Runtime contracts
do not change. Package layouts and Central release metadata do change, so old
verifiers must fail closed on the new asset set and new verifiers must continue
to validate historical evidence only when explicitly invoked from historical
source.

The source archive rejects unchecked extras, symlinks, unsafe paths, runtime
state, credentials, and source/metadata drift. Build arguments bind the runtime
identity to the verified archive. No package installs an OS trust root, stores a
Git credential in Central, or enables Remote Provider access.

## Verification

- policy tests reject restored Darwin/Windows standalone CLI jobs, Intel macOS
  Desktop jobs, Central OCI/default host matrices, and any missing new package;
- package tests inspect bundled helpers and Windows installer ownership;
- Central packaging tests prove one exact source archive, safe/exhaustive
  contents, three controller architectures, release/schema/source identity,
  tamper rejection, and owned temporary-root cleanup;
- controller tests prove install/reentry/backup-first upgrade and runtime build
  identity for the source-build metadata version;
- the final Release verifier requires exactly the 12 named assets before and
  after upload; and
- publication and physical target-host installation remain separate QA gates.
