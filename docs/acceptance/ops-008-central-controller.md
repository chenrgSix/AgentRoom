# OPS-008 Central Controller Acceptance

## Scope and evidence boundary

This acceptance closes the deterministic and single-host implementation gate
for the reentrant Central installation controller. It does not claim a public
GitHub Release, public ACME issuance, a signed binary, high availability, or a
second physical client. The cross-machine onboarding gate remains
`QA-002`/`QA-028`.

The exercised Central source was exact commit `991f508` and used the local
acceptance version `v0.4.0-rc.1`; this label was not published. Existing Docker
projects were inventoried before the run. Both acceptance installations used
unique Compose project names and temporary data roots, and the pre-existing
`agentroom` project had the same `exited(1), running(2)` projection before and
after acceptance.

Host prerequisites reported Docker Engine `29.4.0`, Docker Compose `5.1.2`,
macOS (`darwin/arm64`), and Go `1.26.7` from the pinned module toolchain.

## Controller and release gates

The following gates passed:

```text
GOCACHE=/private/tmp/agentroomctl-go-cache go test ./...
GOCACHE=/private/tmp/agentroomctl-go-cache go vet ./...
GOCACHE=/private/tmp/agentroomctl-go-cache go build ./cmd/agentroomctl
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build ./cmd/agentroomctl
npm run test:compose
npm run lint:docs
git diff --check
```

Focused controller cases cover Linux/macOS on amd64/arm64, release-target
rejection, local/direct origin rules, empty-bootstrap recovery, recorded crash
cuts, exact reentry, secret/config separation, checksum pin/content drift,
backup/staged restore delegation, backup-gated upgrade, active-image failure
reporting, and non-purging uninstall.

From commit `991f508`, the packaging matrix built and the independent verifier
accepted all four pairs:

```text
darwin/amd64
darwin/arm64
linux/amd64
linux/arm64
Verified 4 checksum-pinned Central release archives for v0.4.0-rc.1
```

Each result comprised one `agentroom-central_*.tar.gz` plus its separately
published-style `*.SHA256SUMS.sha256` pin. Verification checked safe archive
members, exhaustive internal hashes, exact source commit, migration/schema
version, binary version/architecture, license identity, executable mode, and
absence of credential/database runtime files. The first real verifier run
rejected the valid tracked `.dockerignore`; commit `991f508` narrowed the fix to
allow a leading dot while preserving archive path and symlink rejection, after
which the matrix was rebuilt from that new exact commit and passed.

## Local-mode lifecycle

The extracted `darwin/arm64` archive installed with project
`agentroom-ops008-991f508`, loopback ports `29080`/`29443`, and origin
`https://localhost:29443`. An initial host-sandbox denial prevented Docker
Buildx from updating its own activity file. Repeating the exact controller
command with Docker access resumed the recorded installation rather than
creating new identity state and reached readiness.

The first ready result reported only the public origin, selected data root,
recovery-file path, release and local CA fingerprint. It did not print the
recovery value. A second exact install preserved both the recovery-file digest
and the live database inode/size. `status` projected healthy Server/Caddy state
plus two successful short-lived init containers. `doctor` then passed release
integrity, private-file modes, Compose configuration, HTTPS readiness, and the
unauthenticated WebSocket authentication boundary.

`backup` produced a mode-`0600`, SHA-256-verified host SQLite copy. With only
this isolated Caddy/Server stopped, `restore` staged the copy under a new
database name, matched its source SHA-256, and left the original database
present. Exact install reentry restarted the original configured database.

Ordinary `uninstall` removed the isolated containers and generated dotenv/
override only. Assertions after uninstall proved preservation of the original
database, staged restore, exported backup, Owner recovery file, Caddy state,
and manifest with `lastSuccessfulStep=uninstalled`. No volume purge was used.

## Direct-HTTPS lifecycle

A separate project `agentroom-ops008-direct-991f508` installed against the
host's non-loopback `192.168.1.4` address and ports `30080`/`30443`. Docker
reported both ingress ports published on `0.0.0.0`; the controller trusted the
installation-local CA and passed HTTPS readiness plus the WebSocket boundary at
the exact LAN origin. Its ordinary uninstall again removed every test
container while preserving database and recovery state.

This proves the direct binding and host-local TLS path, not remote-device reach
from another physical machine. That distinction remains explicit in the open
QA tasks.
