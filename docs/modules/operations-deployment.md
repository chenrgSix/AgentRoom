# Operations and Deployment

## Scope

- Prefix: `OPS`
- Code: `ops/agentroomctl/`, `compose.yaml`, `deploy/`, and repository-owned
  deployment scripts
- Owns: central-host installation manifest and lifecycle orchestration

This module turns an exact central release into the existing Server/Caddy/
SQLite topology. It does not own Team state, migrations, backup contents,
certificate issuance, Docker state, or browser/Bridge onboarding. Those remain
with the Server, persistence module, Caddy, Docker, Web, and Bridge.

## Controller boundary

`agentroomctl` is a small Go 1.26.7 CLI supporting Linux and macOS on amd64 and
arm64. It invokes the existing Compose, startup migration, readiness, backup,
and staged-restore paths. It does not contain a second SQL migration or SQLite
copy implementation.

An installation requires an extracted central release, its internal
`SHA256SUMS`, and the separately published SHA-256 of that checksum file. The
controller first verifies that pin, then requires every regular release file
to appear exactly once in `SHA256SUMS`, rejects symlinks and unchecked extras,
and validates closed release metadata. Compose files are not executed before
this verification passes.

The release workflow builds separate Linux and macOS archives for amd64 and
arm64 from the exact tagged commit. Each archive contains the controller,
Compose/Docker build context, deployment scripts, license assets, closed
release/target/schema metadata, and an exhaustive internal `SHA256SUMS`.
Its companion `*.SHA256SUMS.sha256` asset pins that internal manifest; the
outer Release checksum file covers both the archive and pin asset. The verifier
checks safe members, exact source commit, migration/schema agreement, file
closure, binary version/architecture, license identity, and forbidden runtime
state before upload and after a clean download.

The manifest under `<data-root>/control/installation.json` records only schema
version, exact release and checksum digest, release/data locations, data-schema
version, isolated Compose project name, network mode, domain/origin/ports,
whether legacy Server Token support was selected, timestamps, and the last
successful step. It contains no secret
value, credential, local Runtime configuration, Workspace path, or Team state.
Atomic stage recording makes exact `install` reentry converge after checksum,
storage, secret, render, Compose-validation, service-start, or readiness cuts.
The default Compose project is `agentroom`; an explicitly selected bounded
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

`local` binds Caddy ports to loopback and requires an exact loopback HTTPS
origin. `direct_https` binds the selected ports for external ingress and
requires one matching non-loopback HTTPS origin. Caddy remains certificate and
redirect authority. Readiness verifies the exact HTTPS origin with the system
trust store plus the installation's local Caddy root when present. An
unauthenticated WebSocket upgrade must reach the Server authentication boundary
and return 401/403; a generic HTTP success is not sufficient.

## Lifecycle commands

- `install` validates host versions, ports, free storage, release pin/content,
  atomic state/configuration, Compose, startup migration through Server boot,
  bounded readiness and WebSocket ingress.
- `status` projects the recorded release/origin/step and Compose state.
- `doctor` re-verifies release drift, private-file modes, full Compose config,
  HTTPS readiness and WebSocket ingress without changing Team data.
- `backup` and `restore` call the existing scripts with the exact generated
  Compose model. Restore remains staged, no-overwrite, and requires the Server
  to be stopped.
- `upgrade` verifies the target pin/schema, requires the existing verified
  backup path before target Compose execution, validates target configuration
  in isolation, and commits the new manifest only after readiness. A failure
  keeps the old manifest/backup and reports the currently inspected image while
  preserving the documented forward-only migration boundary.
- `uninstall` runs Compose `down --remove-orphans` without `-v`, removes only
  generated runtime configuration, records `uninstalled`, and preserves the
  data root, manifest, recovery material, backups, database, and Caddy state.
  There is no purge command in this milestone.

Every lifecycle command re-verifies the installed release against the
separately pinned `SHA256SUMS` digest before it executes Compose configuration
or a release-owned script. A directory whose content or checksum manifest has
drifted is diagnostic input only, not trusted executable installation state.

## Verification

Focused tests use real temporary files and a fake process/readiness boundary.
They cover the four supported host/architecture pairs and release-target
rejection, local/direct network
rendering, exact release pin and exhaustive content validation, permissions,
no-secret output/configuration, successful reentry with an existing database,
each recorded external crash cut, conflicting reentry, delegated
backup/restore, backup-before-upgrade, failed-upgrade revision reporting, and
non-purging uninstall. The release verifier separately owns packaging evidence;
real Docker Compose and live TLS evidence is recorded in
`docs/acceptance/ops-008-central-controller.md`. It covers isolated local and
direct-HTTPS host installs without claiming public ACME or a physical second
machine; those remain separate QA evidence.

## Tasks

- `OPS-008`: reentrant central installation controller and release package.
- `QA-028`: deterministic plus physical one-install/one-Device acceptance.
