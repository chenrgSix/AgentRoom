# QA-039 Central Hosted Agent audit fixes

## Goal

Close the post-implementation Central Hosted Agent audit without expanding the
authority accepted by ADR-0026. The repair remains inside the existing Central
Server, Web, SQLite and deterministic fake-provider test surfaces. It does not
change the Bridge protocol or packages, add a deployment service, grant local
computer authority, or require a production provider credential.

## Required closure

- Room removal is authoritative before any Hosted prompt crosses the HTTPS
  dispatch fence.
- Streaming redaction is safe when one sensitive value spans provider deltas.
- Local-to-trusted-team adoption cannot continue using a database-contained
  Hosted wrapping root.
- Profile revision and active-work fences remain authoritative across provider
  probes, and probes have bounded time and concurrency.
- The adapter accepts the supported Responses queued-to-in-progress lifecycle
  while retaining strict event validation.
- Recovered expired Runs settle their durable invocation intent in the same
  process.
- Hosted Presence follows active Room membership, and local databases and
  backups receive restrictive filesystem permissions.
- Web configuration locking uses an explicit Server projection rather than
  inferring active work from Presence.

## Result

- Verification dates: 2026-08-30 to 2026-08-31 (Asia/Shanghai)
- Result: `PASS` for the bounded audit-fix and local deterministic scope
- Verified implementation commit: `d7eb653`
- Environment: Node.js 22.23.1, Go 1.26.7, macOS arm64

The audit findings are closed by the implementation and regression evidence
below. This record does not close the separate production-browser and
release-package admission in [QA-038](qa-038-central-hosted-agents.md).
No live user database, existing backup, production provider or release was
modified during verification.

## Repair evidence

| Boundary | Repair and regression |
| --- | --- |
| Room revocation | `hosted-run-recovery.test.ts` removes membership after an intent is prepared, then proves local failure, settled intent and zero provider calls; dispatch rechecks active Team/Room and exact membership |
| Streaming redaction | `redaction.test.ts` and `hosted-openai-responses-adapter.test.ts` split markers and values across deltas and content parts, cover nested/adjacent markers and control-character normalization, preserve ordinary live output, and keep unfinished sensitive tails private on early EOF |
| Raw/final consistency | The adapter validates raw delta/part/final equality independently of redaction, then verifies that projected output equals the safe final reply |
| Provider lifecycle | Queued creation and queued-to-in-progress execution pass; duplicate, backward, mismatched-identity and unrelated lifecycle events still fail closed, following the documented [Responses lifecycle](https://developers.openai.com/api/reference/java/resources/beta/subresources/responses) |
| Root adoption | Migration 0054 and `hosted-credential-root-upgrade.test.ts` prove atomic rewrapping of current and retired local keyrings, unchanged credential envelopes, rollback on wrong authority, cleanup recovery, restart and online-backup restore; old roots are absent from the active database, WAL and new backup |
| Failed startup cleanup | An injected cleanup failure leaves a durable retry marker and closes the composition root's database connection; the next startup completes cleanup |
| Wrong authority isolation | A wrong recovery root or incompatible mode makes Hosted credential use unavailable without breaking ordinary Central readiness, Owner recovery or Team reads; configuration probes are rejected before any provider request |
| Mutation races | Configuration tests reject stale revisions before probing and recheck current revision, active work and revocation in the final transaction; late checks cannot overwrite a new profile or a busy Agent |
| Probe lifecycle | All configuration entry points share two in-flight slots and a 15-second deadline including queue time; client disconnect and shutdown abort probes; non-cooperative transports retain their slots until settlement |
| Queued probe revocation | A six-case matrix occupies both slots, queues a saved-profile test or profile update, revokes/revises the profile, and proves no delayed credential use, no false successful observation and no leaked capacity |
| Recovery settlement | An expired queued Run settles its existing prepared intent in the same process and never reaches HTTPS |
| Room-derived Presence | Removal, reassignment, archive and restore update Hosted availability; unrelated Room settings do not clear an existing execution degradation |
| Private persistence | New data/backup directories are `0700`; existing/new database, WAL, SHM, journal and direct-backup files are `0600` on POSIX; explicit pre-existing parent directories are preserved and backup targets cannot be overwritten |
| Explicit Web lock | Server configuration projections include `configurationLocked` and `hasActiveWork`; Web fences queued work without inferring it from Presence and refreshes locks without discarding model drafts |
| Real HTTP projection | `central-hosted-agent.test.ts` uses a random-port Central listener and fake provider, splits an assignment credential across semantic deltas, and proves ordered contiguous events, matching redacted output/reply/Room message, no secret in API/log projections and no Bridge dependency |

The streaming redactor also passed 79,592 deterministic random-split,
character-split, nested and Unicode equivalence checks against whole-text
redaction. A retained nested-marker case at the 20,000-character output limit
is now a checked-in regression. On this machine, candidate-search optimization
reduced its isolated per-character redaction run from about 1,524 ms to 61 ms;
this is a diagnostic measurement, not a cross-platform timing guarantee.

## Repository verification

| Command or gate | Result |
| --- | --- |
| `npm run validate` | 9 schemas and 125 fixtures pass |
| `npm run build` | Server, Web and generated-contract build pass |
| `npm test` with a task-scoped `GOCACHE` | Full Server, Web, contracts, embedded Bridge UI and sanitized QA evidence gates pass |
| Complete Server suite | 319/319 pass |
| Complete Web suite and TypeScript check | 71/71 pass |
| Focused runtime, SSE, redaction and recovery suite | 67/67 pass |
| Focused configuration service and HTTP API suite | 30/30 pass |
| Root-upgrade and database security suites | Cipher/migration/backup/permission tests pass, including 5/5 root-upgrade and startup-cleanup cases |
| `npm run test:e2e` | 6 pass, 1 explicit live Codex/Pi opt-in skip, 0 fail |
| `npm run test:compose` | Default/custom/legacy profiles and five Caddy validations pass |
| Unchanged Bridge `go test ./...`, `go test -race ./...`, `go vet ./...` | pass |
| Unchanged Bridge desktop-tag test and build | pass on macOS arm64 |
| `npm run lint:docs` and `git diff --check` | pass |

The first full E2E run exposed an obsolete assertion that fixed the number of
output chunks. Stateful redaction may add a safe terminal tail. Commit
`d7eb653` replaces that count assumption with strict lifecycle ordering,
contiguous sequence numbers and exact concatenated/final text, and strengthens
the scenario with a split credential. The corrected focused HTTP scenario and
the subsequent complete E2E run both pass.

Existing warnings remain explicit: Vite reports a bundle above 500 kB, and the
macOS desktop linker reports SDK/deployment-target version warnings. Neither
was hidden by changing gates or treated as physical-platform certification.

## Commit lineage

| Commit | Change |
| --- | --- |
| `049fa0f` | registers the bounded audit-fix goal |
| `9325a01` | revalidates Room scope and settles pre-dispatch expiry |
| `ebe7d95` | derives Hosted Presence from Room changes |
| `4b24c7e` | preserves execution degradation across unrelated Room settings |
| `dfd4c4f` | bounds configuration probes, fixes mutation races and adds explicit Web locks |
| `c0ef6ee` | upgrades keyring authority, cleans old live roots and restricts persistence |
| `46271ce` | rejects unavailable/changed authority before probe dispatch |
| `e3e5de8` | adds boundary-safe streaming redaction and queued lifecycle handling |
| `d7eb653` | strengthens real-HTTP output and secret-leakage acceptance |

## Remaining admission boundary

Only Central Server, Web, SQLite migrations, deterministic tests and their
owning documents changed. Bridge source/protocol, contracts, lifecycle
controller and deployment topology are unchanged; this repair requires no
client upgrade, extra service or Hosted-specific deployment variable.

Production-browser acceptance, release artifacts, native Windows/other physical
platforms and paid production-provider behavior remain outside this record.
POSIX permissions do not establish Windows ACL protection. Previously exported
local-mode backups and filesystem snapshots retain their original protection
boundary; the upgrade does not delete or retroactively scrub them.
