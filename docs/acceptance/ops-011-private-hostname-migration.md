# OPS-011 Private Hostname Migration Acceptance

Date: 2026-08-28

## Outcome

Central no longer treats a DHCP lease as the durable identity of a local
scoped-private installation. The lifecycle controller can move an eligible
literal-IP origin to one stable LAN hostname, issue a new leaf certificate
under the existing private CA, and retain every installation and authority
boundary that is independent of the origin.

The current local installation was upgraded with an unpublished exact-commit
test package and migrated successfully:

```text
https://192.168.1.132:40000
  -> https://chenzhirong.local:40000
```

This is local acceptance evidence, not a public release claim.

## Preserved State

Before and after migration, the following values were unchanged:

- installation ID `install_meZWyu9hY64UY1knIwOU7d8e`;
- private CA ID `agentroom-1-77cb3afc1117cbe0`;
- CA certificate SHA-256
  `278d06b4060cb44c2466cd78a36847f41688f155367901b57103d221399a52fc`;
- trust epoch `1`;
- Compose project `agentroom-qa030-v040-40000`; and
- database inode `64898197` and size `1380352` bytes.

The committed manifest records `direct_https`, `private_scoped_ca`, data schema
`48`, release `v0.4.0-qa030.8`, domain `chenzhirong.local` and public origin
`https://chenzhirong.local:40000`. Owner recovery material, Device credentials
and Team data were not read, printed, replaced or re-enrolled by the migration.

The upgrade created a verified online backup at
`exports/agent-room-20260828T140619Z.sqlite`. Its SHA-256 is
`ed65a3e9ce430a05828515df50c446ca45f5db485a938318e08a24a05cd27127`.

## Live Verification

The exact installed controller reported:

```text
PASS: v0.4.0-qa030.8 at https://chenzhirong.local:40000
Release checksums, private files, Compose model, HTTPS readiness, and WebSocket ingress are valid.
```

An HTTPS request to `/api/health/ready` used the retained scoped CA, normal
hostname verification and no TLS bypass, and returned `{"status":"ready"}`.
Both the current `/.well-known/convenewire/bridge-ca.pem` path and the legacy
`/.well-known/agentroom/bridge-ca.pem` compatibility path returned bytes exactly
equal to the retained CA file. The Server container was healthy and Caddy was
running after migration.

## Regression Evidence

The controller suite covers eligible migration, exact preserved fields,
same-CA descriptor rewrite, active-rotation and invalid-target rejection,
candidate rollback, local loopback transport with the recorded TLS ServerName,
legacy release-manifest compatibility, legacy trust bootstrap paths and legacy
lifecycle environment aliases.

The implementation passed:

```text
go test ./...
go test -race ./internal/controller
go vet ./...
go build ./cmd/convenewirectl
npm run test:compose
npm run lint:docs
```

## Boundary

The product does not reserve DHCP leases, edit DNS, install an OS CA, write a
hosts file or disable TLS verification. `chenzhirong.local` must still resolve
on the client network. The live result proves Central migration on macOS; it
does not claim that an already-paired packaged Windows Bridge has exercised the
BRG-048 reconnect path. That remains separate physical-platform evidence after
a release containing BRG-048 is installed.
