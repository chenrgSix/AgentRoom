# AgentRoom Central Controller

Use the `agentroomctl` binary shipped in the Central archive for the host's
operating system and architecture. Keep the extracted release directory
unchanged: every lifecycle command re-verifies it before executing Compose or a
release-owned script.

The separately downloaded `*.SHA256SUMS.sha256` asset contains the digest to
pass with `--checksums-sha256`. It is not the same as the outer Release
`SHA256SUMS`, which verifies downloaded assets.

For a loopback-only first installation:

```sh
./bin/agentroomctl install \
  --release-dir "$PWD" \
  --checksums-sha256 '<published internal checksum digest>' \
  --data-root '/absolute/persistent/agentroom-central' \
  --mode local \
  --domain localhost \
  --origin https://localhost:9443
```

For a LAN or DNS origin, use `--mode direct_https`, make `--domain` and
`--origin` name the same stable host, and explicitly expose the selected ports.
The controller reports the Owner recovery file and local TLS root fingerprint;
it never prints the recovery value or optional legacy Server Token.

Run `status` for the recorded installation/Compose projection and `doctor` for
release, permission, Compose, HTTPS and WebSocket checks. `backup`, staged
`restore`, backup-gated `upgrade`, and non-purging `uninstall` all require the
same `--data-root`.

The ordinary uninstall path removes containers and generated runtime
configuration only. Database files, backups, recovery material, Caddy state,
and the installation manifest remain under the selected data root.
