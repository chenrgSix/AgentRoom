# OPS-012 Central lifecycle authority acceptance

- Date: 2026-08-29
- Scope: deterministic local implementation evidence
- Result: PASS

## Boundary under test

The Central controller owns the generated installation configuration and every
mutation of one data root. A parent shell may supply ordinary host settings
needed to locate Docker, but exported ConveneWire or legacy AgentRoom product
variables cannot replace the controller's database, origin, port, image, TLS,
secret-file or Compose identity. Only one mutating controller command may own a
data root at a time, and a stale manifest snapshot cannot overwrite a newer
commit.

This task does not change raw Compose compatibility. An operator who invokes
Compose directly still owns the environment they pass. It also does not publish
a Release, change a running installation, or claim physical-machine evidence.

## Implementation evidence

- `ExecRunner` constructs a closed child environment: it retains ordinary host
  variables, rejects ambient `CONVENE_WIRE_*` and `AGENT_ROOM_*`, and then adds
  only explicit command values read from controller-owned files.
- Mutating install, backup, restore, upgrade, uninstall, public-CA migration,
  private-hostname migration and private-CA prepare/activate paths acquire the
  same owner-only non-blocking data-root lock.
- Context-scoped reentry permits the required upgrade-to-backup call without
  permitting a second process or a second data root.
- The lock file is rejected when it is a symlink, non-regular object or
  group/world-accessible file. A sole valid lock file does not make a new data
  root look like unowned existing installation state.
- Manifest schema v2 accepts historical generation-less files. Each new commit
  compares the loaded generation, increments it and rejects stale snapshots.
- Atomic controller writes sync the installed file and its parent directory.

## Negative regressions

- ambient database path, public origin and legacy domain are absent from the
  child environment;
- an explicit controller value replaces, rather than merges with, the ambient
  product value;
- a blocked backup causes concurrent uninstall to return `LIFECYCLE_BUSY`
  before uninstall reaches the Runner;
- a nested same-operation lock succeeds, while a second independent owner is
  rejected;
- an unsafe lock symlink fails before mutation;
- a stale generation receives `MANIFEST_STALE` and leaves the newer manifest
  unchanged.

## Executed gates

```text
GOCACHE=/private/tmp/convenewire-ops-hardening-gocache go test -race ./internal/controller
PASS

GOCACHE=/private/tmp/convenewire-ops-hardening-gocache go vet ./...
PASS

GOCACHE=/private/tmp/convenewire-ops-hardening-gocache go build ./cmd/convenewirectl
PASS

npm run test:compose
PASS: Central Compose defaults and Caddy configuration are valid.

git diff --check
PASS
```

The Compose test uses real Docker Compose interpolation and validates every
packaged Caddy TLS profile. The Go regressions prove the controller removes the
ambient product variables before invoking that precedence model.

## Remaining boundaries

- `OPS-013` owns immutable prebuilt Central runtime images.
- `QA-034` owns exact full-CI SHA binding for Release jobs.
- backup activation and fresh physical two-machine acceptance remain separate
  tasks and are not implied by this result.
