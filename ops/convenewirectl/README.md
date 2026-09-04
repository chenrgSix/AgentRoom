# ConveneWire Central Controller

Use the `bin/convenewirectl` launcher shipped in the host-neutral Central source
archive. It selects the checksum-covered helper for Linux amd64/arm64 or macOS
arm64. Keep the extracted release directory unchanged: every lifecycle command
re-verifies it before executing Compose or a release-owned script.

Default owner-state directories and the hidden Compose project, service,
manifest, and database identities retain their released `AgentRoom` names so
an in-place upgrade reopens the same installation. New archives, commands,
images, and generated environment variables use ConveneWire naming.

The separately downloaded source-package `*.SHA256SUMS.sha256` asset contains the digest to
pass with `--checksums-sha256`. It is not the same as the outer Release
`SHA256SUMS`, which verifies downloaded assets.

Install and upgrade build Server/Web locally from the verified package with
Docker Compose. Docker and Compose are required; Go and Node.js are not. The
digest-pinned Node base and Caddy images must already exist or be downloadable.
For a loopback-only first installation:

```sh
./bin/convenewirectl install \
  --release-dir "$PWD" \
  --checksums-sha256 '<published internal checksum digest>' \
  --data-root '/absolute/persistent/convenewire-central' \
  --mode local \
  --domain localhost \
  --origin https://localhost:9443
```

For ordinary use on a trusted private LAN, use `--mode lan_http`. The browser
uses the selected HTTP port without a CA installation, while Bridge, Device and
execution traffic retain the same host's private-CA HTTPS origin:

```sh
./bin/convenewirectl install \
  --release-dir "$PWD" \
  --checksums-sha256 '<published internal checksum digest>' \
  --data-root '/absolute/persistent/convenewire-central' \
  --mode lan_http \
  --domain central.local \
  --origin https://central.local:9443 \
  --http-port 9080 \
  --https-port 9443
```

LAN browser HTTP is convenient but unencrypted. Do not use it across an
untrusted network or the public internet. For those deployments use
`--mode direct_https`, make `--domain` and `--origin` name the same stable host,
and explicitly expose the selected ports. Omitting `--tls-profile` selects
fail-closed public ACME and normal system trust. For advanced private-browser
HTTPS on a private IP or name, explicitly select Bridge-scoped trust:

```sh
./bin/convenewirectl install \
  --release-dir "$PWD" \
  --checksums-sha256 '<published internal checksum digest>' \
  --data-root '/absolute/persistent/convenewire-central' \
  --mode direct_https \
  --tls-profile private_scoped_ca \
  --domain 192.168.1.132 \
  --origin https://192.168.1.132:9443
```

For local self-hosting on DHCP, prefer a stable private DNS or mDNS hostname
over a literal address. To move an existing ready scoped-private IP installation
without changing its CA, installation ID, trust epoch, database or Device
credentials:

```sh
./bin/convenewirectl migrate-private-hostname \
  --data-root '/absolute/persistent/convenewire-central' \
  --hostname central.local
```

The hostname must already resolve to the Central host. The controller verifies
the new hostname and same CA before committing, and restores the old topology on
failure. Update an existing current Bridge through Connection Settings after
the Central move; it verifies the replacement hostname through the already
pinned CA before retaining the Device credential. A new Bridge pairs directly
against the hostname.

Switch an existing ready scoped-private installation without changing its CA,
Device credentials or data:

```sh
./bin/convenewirectl migrate-browser-transport \
  --data-root '/absolute/persistent/convenewire-central' \
  --mode lan_http

./bin/convenewirectl migrate-browser-transport \
  --data-root '/absolute/persistent/convenewire-central' \
  --mode direct_https
```

The controller stages and checks both browser and Bridge ingress, commits the
manifest last, and restores the previous files and topology on failure.

`manual_ca` is advanced operator-managed compatibility; the controller never
installs an OS root. It reports only the non-secret installation ID, TLS profile
and a redacted CA-digest prefix, never the recovery value, full digest, CA
private key, or optional legacy Server Token.

Private scoped deployments do not require a Bridge host to install the Caddy
root. Rotate that deployment in two explicit phases while the current CA is
still serving:

```sh
./bin/convenewirectl trust-rotation prepare \
  --data-root '/absolute/persistent/convenewire-central' \
  --overlap 24h

./bin/convenewirectl trust-rotation activate \
  --data-root '/absolute/persistent/convenewire-central'
```

`prepare` makes Caddy provision one named next authority and publishes only its
canonical public certificate over the existing Device-authenticated channel.
`activate` refuses to switch until every eligible non-revoked private Device has
acknowledged that exact epoch and digest. It then reloads Caddy, verifies the new
chain, commits the manifest/public artifact, and retires the old served
authority. Failed new-chain readiness restores the current-first two-authority
profile. No command edits an OS trust store or exposes a CA private key.

For a schema-v1 legacy installation already serving a publicly trusted DNS
certificate, the explicit inspected migration is:

```sh
./bin/convenewirectl migrate-public-ca \
  --data-root '/absolute/persistent/convenewire-central'
```

It requires system-only HTTPS/WebSocket readiness both before and after the
profile change. Private, manual, IP, unready, or otherwise ambiguous legacy
state stays `legacy_unclassified`; it is never relabeled by install reentry.

Run `status` for the recorded installation/Compose projection and `doctor` for
release, permission, Compose, HTTPS and WebSocket checks. `backup`, staged
`restore`, backup-gated `upgrade`, and non-purging `uninstall` all require the
same `--data-root`.

The ordinary uninstall path removes containers and generated runtime
configuration only. Database files, backups, recovery material, Caddy state,
and the installation manifest remain under the selected data root.
