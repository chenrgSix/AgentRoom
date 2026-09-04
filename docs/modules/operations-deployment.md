# Operations and Deployment

## Scope

- Prefix: `OPS`
- Code: `ops/convenewirectl/`, `compose.yaml`, `deploy/`, and repository-owned
  deployment scripts
- Owns: central-host installation manifest and lifecycle orchestration

This module turns an exact central release into the existing Server/Caddy/
SQLite topology. It does not own Team state, migrations, backup contents,
certificate issuance, Docker state, or browser/Bridge onboarding. Those remain
with the Server, persistence module, Caddy, Docker, Web, and Bridge.

It does own selection and persistence of the deployment TLS profile and the
public trust-bootstrap artifact consumed by those modules. Caddy still owns
issuance and private keys; Operations cannot authorize a Device or make a Web
browser trust a private CA.

## Controller boundary

`convenewirectl` is a small Go 1.26.7 CLI. New source-build Central archives
carry checksum-covered helpers for Linux amd64/arm64 and macOS arm64 behind one
host-selecting launcher. It invokes the existing Compose, startup migration,
readiness, backup, and staged-restore paths. It does not contain a second SQL
migration or SQLite copy implementation.

An installation requires an extracted central release, its internal
`SHA256SUMS`, and the separately published SHA-256 of that checksum file. The
controller first verifies that pin, then requires every regular release file
to appear exactly once in `SHA256SUMS`, rejects symlinks and unchecked extras,
and validates closed release metadata. Compose files are not executed before
this verification passes.

OPS-013 release history built one Linux OCI bundle per amd64/arm64 architecture
from the exact resolved Release commit, then embeds that same architecture's
bundle unchanged in both its Linux and macOS controller archives. Each bundle
contains the Server and pinned Caddy images, a strictly derived
Docker-save-compatible `manifest.json` projection for classic Docker image
stores, per-image SPDX statements, one exact-source provenance statement and
closed metadata binding Release, source, platform, archive hash, OCI manifest
digests, Docker config image IDs, builder and pinned SBOM generator. The Docker
manifest may reference only the same configs and ordered layers already
selected by the verified OCI manifests.
After load, runtime activation selects one complete store-supported generation:
both immutable config image IDs for a classic Docker image store, or both
repository-qualified OCI manifest digests for a containerd image store. A
partial or mixed Server/Caddy generation fails closed. OCI manifest digests
remain the SBOM/provenance subjects. The images are never published under a
mutable registry tag as an installation dependency.

Those image-backed Central archives also contain the controller, Compose source context for
explicit schema-v1 compatibility, deployment scripts, license assets, closed
release/target/schema metadata, and an exhaustive internal `SHA256SUMS`.
Its companion `*.SHA256SUMS.sha256` asset pins that internal manifest; the
outer Release checksum file covers both the archive and pin asset. The verifier
checks safe members, exact source commit, migration/schema agreement, file
closure, binary version/architecture, license identity, forbidden runtime
state, OCI descriptor/blob closure, image labels, attestations and identical
per-architecture embedding before upload and after a clean download.

ADR-0041 defines the new default distribution. One host-neutral
`convenewire-central_<version>_source.tar.gz` contains the exact locked
Server/Web/Contracts build context, Compose and Caddy files, backup/restore
scripts, licenses, closed release metadata, three supported host controller
helpers and an exhaustive internal checksum manifest. Its separately published
pin and the outer Release checksum preserve the existing two-level verification
boundary. Install and upgrade build the Server image locally with Docker from
the verified source and inject the exact Release/source identity as build
arguments. Runtime readiness rechecks that identity. The default Release no
longer embeds an offline OCI bundle; missing digest-pinned base images therefore
require operator-approved network access or a separately supplied optional
offline extension.

The schema-v2 installation manifest under
`<data-root>/control/installation.json` records
the stable non-secret installation ID, selected TLS profile, private trust epoch
and canonical CA DER digest in addition to the exact release/checksum,
release/data locations, data-schema version, isolated Compose project name,
network mode, domain/origin/ports, legacy Server Token selection, timestamps,
and last successful step. New image-backed Releases additionally record the
source commit, the exact selected Server/Caddy reference pair and Linux
platform. It
contains no secret value,
credential, local Runtime configuration, Workspace path, or Team state.
Atomic stage recording makes exact `install` reentry converge after checksum,
storage, secret, render, Compose-validation, service-start, or readiness cuts.
The default Compose project remains the upgrade-stable `agentroom`; an explicitly selected bounded
project name supports isolated acceptance or an intentionally separate host
installation and becomes part of the reentry identity.

Owner recovery material and an optional legacy Server Token are generated with
cryptographic randomness into separate 0600 files and never printed. The
generated dotenv file contains only non-secret deployment values. If legacy
compatibility is selected, the controller reads its secret file into the child
Compose process environment for each lifecycle command; it is not copied into
the manifest or dotenv file. Reentry validates and reuses both files instead
of generating new authority.

## Storage and process boundary

The selected data root uses restrictive host directories for database data,
backups, exported backups, recovery material, prepared container secrets,
Caddy data/config, and controller state. A short-lived, network-disabled
`data-init` service gives the image's non-root `node` account ownership of the
bind-mounted database and backup directories. The long-running Server remains
non-root with all capabilities dropped. `secret-init` remains a separate
network-disabled copy boundary; the raw host recovery file is not mounted into
the Server.

Compose normalizes authoritative `CONVENE_WIRE_DOMAIN` and
`CONVENE_WIRE_PUBLIC_ORIGIN` values with an optional legacy `AGENT_ROOM_*`
fallback. It does not use a nested Compose `:?` assertion because Compose
evaluates that inner assertion even when the authoritative value is present.
Missing authority still fails closed in the Server/Caddy/controller validation
path; no default hostname, origin or TLS bypass is synthesized. The Compose
regression runs current-only and legacy-only environments without inheriting
the operator's local aliases.

`OPS-012` closes the controller-specific parent-process boundary. Every child
inherits ordinary operating-system settings such as `PATH`, `HOME`, Docker
context and credential-helper variables, but all ambient `CONVENE_WIRE_*` and
`AGENT_ROOM_*` values are removed first. The controller then adds only the
explicit secret-file values required by that command; every other product
setting comes from the verified generated dotenv file. Consequently an
operator's exported database path, origin, port, image or TLS variable cannot
override a controller-owned installation even though raw Compose intentionally
retains its documented compatibility aliases.

## Optional Central Hosted Agent Boundary

[ADR-0026](../adr/0026-add-optional-central-hosted-agents.md) is implemented as
code inside the existing Server image. It adds no service, sidecar, container,
image, process, port, volume, bind mount, Docker socket, health dependency,
Compose key, environment variable, startup argument, generated dotenv field,
installation-manifest field, or lifecycle-controller command. The normal
Server image rebuild is the only deployment artifact change.

Hosted configuration occurs after startup through authenticated Web APIs and is
stored with the existing SQLite data. Packaged trusted-team deployments reuse
the already prepared Owner recovery authority for domain-separated credential
wrapping; there is no Hosted-specific `master.key` or secret directory. Online
backup and staged restore carry encrypted Hosted rows through the existing
database path without Operations decrypting or reporting a provider key.

An unconfigured installation makes no provider request and has identical
startup/readiness behavior. Once an Owner configures a profile, only the Server
needs outbound HTTPS reachability to its code-defined provider origin. Egress
denial, DNS/TLS failure, provider outage, or credential revocation degrades that
Hosted Agent only. Caddy, Bridge ingress, Device pairing, managed execution,
backup, upgrade, status, doctor, and Central readiness remain independent.

The Server container stays non-root with dropped capabilities. Hosted execution
does not scan the host for Pi/Codex, start a child Runtime, mount a Workspace,
read a host path, access a desktop, or control Docker. Those capabilities remain
available only through an explicitly installed and paired Bridge.

`local` binds Caddy ports to loopback and requires an exact loopback HTTPS
origin. `direct_https` binds the selected ports for external ingress and
requires one matching non-loopback HTTPS origin. [ADR-0040](../adr/0040-separate-lan-browser-and-bridge-transports.md)
adds explicit `lan_http`: the recorded `publicOrigin` remains the private-CA
HTTPS Bridge origin, while Operations derives a same-host HTTP browser origin
from the recorded HTTP port and selects an application-serving HTTP Caddy
profile. Existing modes keep the redirect profile, and no mode silently falls
back to HTTP. Caddy remains certificate and redirect authority. Public-profile
readiness uses only the system trust store
and cannot consume a Caddy-local fallback. Local, advanced manual and explicitly
private profiles may add the installation root; private readiness also requires
its DER digest to agree with the manifest. This is host diagnostic behavior,
not evidence that a second-machine Bridge has safe trust.
An unauthenticated WebSocket upgrade must reach the Server authentication
boundary and return 401/403; a generic HTTP success is not sufficient.

`lan_http` readiness proves both paths independently: the exact HTTPS origin
must pass CA, hostname, health and WebSocket authentication checks, and the
derived HTTP browser origin must pass application health through Caddy. The
controller owns an explicit rollback-safe transport migration only between
`direct_https/private_scoped_ca` and `lan_http`; it does not rewrite
public/manual TLS deployments or preserve browser login Cookies across the
transport change.

For private local self-hosting, the exact origin should be a stable DNS or mDNS
hostname rather than a literal DHCP address. The hostname remains the TLS and
Origin-policy identity while its resolved interface address may change.
[ADR-0024](../adr/0024-decouple-private-central-identity-from-dhcp-address.md)
defines the bounded one-time migration for an existing literal-IP installation;
it does not change the `0.0.0.0` listener, install a CA, manage DHCP/DNS or relax
hostname validation.

### Accepted TLS-profile target

[ADR-0023](../adr/0023-default-public-ca-and-scope-private-bridge-trust.md)
adds a TLS profile beneath `direct_https` without changing the network-mode
boundary:

| Profile | Controller contract |
| --- | --- |
| `public_ca` | default; require exact owned hostname and publicly trusted ACME chain; fail without fallback |
| `private_scoped_ca` | explicit; retain Caddy local CA, publish its bounded public root and origin-bound descriptor for Bridge pairing |
| `manual_ca` | explicit advanced compatibility; report instructions/state but never mutate an OS trust store |

The CLI option is `--tls-profile`; omission under `direct_https` means
`public_ca`, while any TLS profile supplied with `local` is invalid.

`OPS-009` records a stable non-secret installation ID, TLS profile, monotonic
trust epoch, named Caddy private-authority ID and canonical public CA DER digest
in manifest schema v2; reentry preserves them. Schema-v2 manifests created
before named authorities retain the exact built-in `local` ID rather than
silently generating a different root. The controller copies exactly one validated canonical
certificate into a bounded public-artifact directory. It is exposed only at
`/.well-known/convenewire/bridge-ca.pem` with one-certificate, no-redirect, size,
media-type and cache-policy constraints. The manifest and endpoint never
contain the Caddy private key.

Public-CA readiness uses only normal system validation. Private-scoped host
readiness verifies the exact CA/digest/hostname path separately and proves the
well-known artifact agrees with the manifest. Manual CA and legacy leaf-pin
state is reported as advanced compatibility. A new public install cannot
silently become any of those modes after DNS, ACME or chain failure.
Controller readiness dials the host's Caddy ingress through loopback while the
request URL still supplies and verifies the exact recorded hostname, TLS SNI,
certificate chain and Origin. This avoids treating DHCP routing or router
hairpin behavior as local process health; it does not claim another Device can
resolve or reach the hostname, which remains a separate physical QA boundary.

Private CA rotation uses `trust-rotation prepare` and `trust-rotation activate`.
Prepare reloads a Caddy model containing exactly current plus next named
authorities, verifies the next canonical root, and only then publishes one
bounded next-epoch offer. Activate inspects acknowledgement counts through the
running Server container, refuses a partial eligible-Device set, establishes a
0600 recovery journal, selects only the next issuer, and requires exact
CA-digest HTTPS/WebSocket readiness before advancing the manifest and public
artifacts. A failed new-chain check restores the current-first two-authority
model; a completed journal can finish cleanup without generating another CA.

An old manifest without a TLS profile remains readable and reports
`legacy_unclassified`; install reentry cannot relabel it. The explicit
`migrate-public-ca` operation requires a public-DNS origin and system-only
readiness before and after selecting the packaged ACME profile. Failed,
private, manual, IP, or ambiguous state retains the legacy manifest. The
migration does not rewrite
Bridge state, install/remove OS roots, rotate a CA, or claim scoped migration.
Moving a private installation into scoped mode requires the complete
Contract/Security/Web/Bridge path and a fresh pairing or authenticated overlap,
not a manifest-only label change.

## Lifecycle commands

Every mutating command owns one non-blocking advisory lock at
`<data-root>/control/lifecycle.lock`. The owner-only regular lock is neutral for
first install and persists as coordination state; a competing process receives
`LIFECYCLE_BUSY` before it executes a second Docker or release-script command.
Nested controller operations, notably `upgrade` invoking the required `backup`,
reuse the same context-scoped owner. A command cannot use that owner to mutate
another data root.

Manifest schema v2 remains compatible and gains an optional monotonic
`generation`. Existing generation-less manifests begin at zero. Every lifecycle
commit compares the generation it loaded with the current on-disk generation,
increments exactly once and rejects stale state with `MANIFEST_STALE`. The
process lock supplies cross-process exclusion; generation CAS additionally
prevents a stale in-process snapshot from becoming the last writer. Atomic
configuration and manifest replacement syncs both the file and its parent
directory before reporting success.

- `install` validates host versions, ports, free storage, release pin/content,
  atomic state/configuration, Compose, startup migration through Server boot,
  bounded readiness and WebSocket ingress.
- `status` projects the recorded release/origin/step and Compose state.
- `doctor` re-verifies release drift, private-file type, mode and exact
  controller-generated authority format, full Compose config, HTTPS readiness
  and WebSocket ingress without changing Team data.
- `backup` and `restore` call the existing scripts with the exact generated
  Compose model. Restore remains staged, no-overwrite, and requires the Server
  to be stopped.
- `upgrade` verifies the target pin/schema and the existing Owner recovery plus
  optional legacy-token authority before backup or target Compose execution.
  Missing, malformed or unsafe authority fails closed without regeneration.
  It then requires the existing verified backup path, validates target
  configuration in isolation, and commits the new manifest only after
  readiness. A later failure keeps the old manifest/backup and reports the
  currently inspected image while preserving the documented forward-only
  migration boundary.
- `trust-rotation prepare` provisions and publishes one strictly newer private
  CA while the old CA stays first; `activate` requires all eligible Device
  acknowledgements and new-chain readiness, with current-first rollback.
- `migrate-public-ca` performs the only schema-v1 TLS relabel and only after
  system trust proves the existing and resulting public certificate path.
- `migrate-private-hostname` moves only a ready scoped-private literal-IP
  origin to one exact non-loopback hostname. It preserves the private CA,
  trust epoch, installation identity and data, requires same-CA hostname
  readiness, and restores the old topology if the candidate fails.
- `uninstall` runs Compose `down --remove-orphans` without `-v`, removes only
  generated runtime configuration, records `uninstalled`, and preserves the
  data root, manifest, recovery material, backups, database, and Caddy state.
  There is no purge command in this milestone.

Every lifecycle command re-verifies the installed release against the
separately pinned `SHA256SUMS` digest before it executes Compose configuration
or a release-owned script. A directory whose content or checksum manifest has
drifted is diagnostic input only, not trusted executable installation state.

Release-metadata schema 3 is the current ADR-0041 source-build contract. It is
host-neutral, records `targetOS=source` and `targetArch=multi`, and requires the
controller to invoke Compose build with the exact verified Release/source
identity. Readiness is insufficient unless the running Server reports that same
identity. Status, doctor, reinstall and upgrade continue to revalidate the
installed release closure before any lifecycle operation.

Release-metadata schema 2 remains the accepted image-backed compatibility
contract. Before Compose validation or start, the controller verifies the
embedded OCI archive, its exact Docker-save projection and attestations against
the already pinned release, imports it with `docker image load`, resolves one
complete config-ID or repository-qualified manifest-digest pair, atomically
records that selection before rendering Compose configuration, inspects both
exact identities and platform, and runs Compose with `--no-build --pull never`.
It cannot silently fall back to a source build after missing image content,
Docker failure or registry reachability. Release-metadata schema 1 remains the
legacy source-build compatibility path.

## Verification

Focused tests use real temporary files and a fake process/readiness boundary.
They cover the current Linux amd64/arm64 and Apple-silicon macOS controller
hosts, historical release fixtures and release-target rejection, local/direct network
rendering, exact release pin and exhaustive content validation, permissions,
no-secret output/configuration, successful reentry with an existing database,
each recorded external crash cut, conflicting reentry, delegated
backup/restore, invalid-authority rejection before backup or Compose,
backup-before-upgrade, failed-upgrade revision reporting, and non-purging
uninstall. The release verifier separately owns packaging evidence;
real Docker Compose and live TLS evidence is recorded in
`docs/acceptance/ops-008-central-controller.md`. It covers isolated local and
direct-HTTPS host installs without claiming public ACME or a physical second
machine; those remain separate QA evidence.

`QA-038` verifies the unchanged Compose service/port/volume/environment model,
unconfigured startup and readiness, encrypted SQLite backup/restore, denied
provider egress degradation, and execution against a fixed fake HTTPS provider.
It does not add an Operations task or require a real paid provider credential.

`OPS-009` evidence covers public-default selection, ineligible-host no-fallback
errors, legacy no-relabel behavior, inspected public migration, one bounded
public-CA artifact, named current/next PKI provisioning, strict acknowledgement
admission, idempotent overlap staging, exact next-chain commit, rollback,
private digest agreement, and negative multiple-certificate/private-key output
checks. Real Caddy validation includes the generated two-authority model. Those deterministic checks do
not by themselves prove Web projection, Bridge bootstrap, browser trust or two
physical machines; `SEC-009`, `BRG-045`, `WEB-048`, `QA-030`, and `QA-002` own
those boundaries.

`OPS-012` adds a closed-environment regression for authoritative versus ambient
product variables, same-root lock contention with proof that the rejected
operation executes no child command, nested-lock reentry, unsafe lock-file
rejection, install neutrality, manifest generation advancement and stale-CAS
rejection. The controller suite passes under the Go race detector; Go vet,
controller build and the real Docker Compose/Caddy configuration validation
also pass. [Acceptance evidence](../acceptance/ops-012-lifecycle-authority.md)
records the exact boundary without claiming multi-host or release publication.

`OPS-013` adds structural mutation tests for OCI descriptors, Docker-save
projection, blobs, labels, SBOMs, provenance, metadata and controller commands.
The current Docker verifier requires all four candidate references to be absent,
loads only the finalized archive, selects one complete store-supported pair,
inspects the expected immutable identity/platform/Release/source labels, and
executes Server and Caddy from that same pair with `--pull=never`, no network
and a read-only root. [Acceptance
evidence](../acceptance/ops-013-immutable-central-images.md) records one
exact-commit `linux/arm64` archive passing the complete Server/Caddy gate in
Docker 29.4 containerd storage through its manifest-digest pair and in an
isolated Docker 28.0.4 classic store through its config-ID pair. `QA-034`
[hosted Release evidence](../acceptance/qa-034-exact-release-workflow.md) adds
successful clean-daemon execution for both Linux architectures and all four
matching schema-v2 archive builds in Release run `33287755768`. Target-host
lifecycle acceptance remains separate from both implementation and hosted
publication evidence.

## Tasks

- `OPS-008`: reentrant central installation controller and release package.
- `OPS-009`: public-default and scoped-private TLS deployment target.
- `OPS-011`: private DHCP-IP to stable-hostname migration.
- `OPS-012`: exclusive lifecycle configuration and mutation authority.
- `OPS-013`: immutable exact-digest Central image release and activation.
- `OPS-017`: one exact-source, checksum-closed, locally built Central release.
- `QA-028`: deterministic plus physical one-install/one-Device acceptance.
- `GOV-017`/`QA-038`: optional in-image Hosted Agent boundary and deterministic
  acceptance; no new deployment lifecycle surface.
