# Testing and Observability

## Scope

- Prefixes: `QA` and `OPS`
- Planned location: tests beside modules plus `tests/e2e/`
- Owns: shared fixtures, E2E evidence, telemetry and release gates

This module defines repository-wide verification, operational signals, and
release evidence.

## Test Layers

- Unit tests verify domain transitions, validation, and policy decisions.
- Contract tests verify JSON Schema in TypeScript, Go, and each adapter.
- Integration tests exercise SQLite, WebSocket, MCP, Bridge, and recovery seams.
- E2E tests run public API-to-server-to-real Bridge process workflows.
- Security tests prove unauthorized and unsafe operations are rejected.

Every behavioral fix adds a focused regression. Protocol changes require
cross-language compatibility tests. The deterministic FakeAdapter is the
default for races, disconnects, duplicate delivery, and timeout scenarios.

Runtime activity coverage treats official reasoning summaries as untrusted
output. Go parser/executor tests with split secret fragments, TypeScript
WebSocket persistence tests, Web projection tests, and the real paired-Bridge
Pi E2E must agree on one sequence while proving structured commands, arguments,
tool results, and hidden reasoning never become central payloads.

Every push to `main` and every pull request runs schema validation, generated
contract checks, Node builds and tests, deterministic cross-process E2E,
Markdown lint, Go tests and vet, plus a native macOS desktop compile. Release
workflows do not replace this gate.

The `QA-001` integration test exercises one authenticated user, one Team and
Room, two Fake Agents, stable-ID mentions, ordered Run events, Agent replies,
and SQLite reload through the public HTTP API. It is the central MVP gate; it
does not claim production Bridge, WebSocket, or browser automation coverage.

`QA-006` starts a real TCP server, builds and pairs the Go Bridge, publishes a
managed Generic CLI Agent, sends a structured Mention through the Web API, and
asserts the durable terminal Run and Agent reply. It proves the local
cross-process transport while keeping physical two-machine Codex acceptance as
a separate release check.

The physical `QA-002` procedure is maintained in
`docs/acceptance/qa-002-two-machine-managed-agent.md`. It requires two real
machines, HTTPS and fingerprint verification, a released Bridge archive, local
Codex, online execution, offline queue/reconnect, one trace reconstruction, and
a sanitized committed PASS record. Local processes and containers cannot close
this task.

`QA-003` uses only public Web and Remote MCP endpoints. A Team Owner assigns a
root Run to Alice Agent, Alice hands off to Bob Agent, and Bob hands off to
Carol Agent. All three Agents claim and complete their Runs; the test verifies
parent lineage, one shared trace, ordered Room replies, and rejection when
Carol attempts to revisit Alice.

The recovery matrix combines server restart persistence for Run, Delivery, and
event sequence; Bridge durable inbox restart to `outcome_unknown`; duplicate
ACK and event idempotency; offline reconnect delivery; expiry; and a real
cross-process cancellation. Each case has a deterministic regression test.

Discussion verification uses a deterministic evaluator fixture and fake usage
telemetry. It covers early completion, multi-dimensional lease renewal,
plateau detection, policy precedence, reserved finalization, stale decision
fencing, user control at Wave boundaries, optional assessment transport, and
reply-only Codex/Generic CLI downgrade without calling a model. The standalone
semantic-evaluator contract test normalizes evidence and strips attempted state
or action authority. It is not an Orchestrator integration test: the MVP
Orchestrator has no evaluator injection and calls no semantic model.

Parallel Wave tests permute member callback order and assert one identical
aggregate. They also cover duplicate terminal callbacks, all-success,
partial-success, all-failed, deadline resolution, `input_required`, cancel-all,
logical `turnsUsed` versus committed execution-slot `agentRunsUsed`, and a
single-member finalization Wave. Public API and component acceptance prove that
two Fake Agents start in one Wave and display independent outcomes. `QA-010`
also verifies deterministic-anchor retry, participant-ordered bounded context,
and reopened-SQLite recovery at all three durable cut points.

`QA-007` runs only when explicitly requested with `npm run test:e2e:live`.
The verified 2026-08-23 run used Codex CLI `0.149.0-alpha.4.1` as a read-only
Solver and Pi `0.84.2` as a no-tools Generic CLI Reviewer. A temporary server,
SQLite database, Bridge identity, and inbox proved Codex-to-Pi scheduling,
structured assessment transport, one useful automatic lease extension, the
soft boundary, user-requested finish, Pi finalization, and cleanup. This is
evidence for the earlier sequential path, not the parallel Wave release gate.
Deterministic Orchestrator tests remain the stable evidence for early finish,
plateau, and hard-budget reserved finalization.

The verified 2026-08-24 parallel gate used the same local Codex and Pi versions
through an isolated temporary server, database, Bridge identity, and inbox.
Both Agents contributed in one concurrent Wave and Pi completed the
single-member finalization Wave. The non-sandbox run finished in about 91
seconds; no existing Team, Bridge configuration, or session data was changed.

## Required Scenarios

The release suite covers offline queueing, ACK loss, duplicate delivery,
out-of-order status/output/activity/reply events, cancellation races, restart recovery, capability
downgrade, sensitive-output filtering, and the three-member handoff journey
defined by the architecture baseline. Discussion scenarios additionally cover
useful continuation, low-value repetition, unresolved high-priority issues,
missing usage telemetry, optional Reviewer policies, callback permutations,
partial and total Wave failure, `input_required`, deadline classification,
cancel-all, Reviewer same-Wave contribution and finalizer preference,
deterministic `wave_result` retry, participant-ordered context, and the three
durable recovery cut points.

## Observability Contract

One `traceId` follows Message, Run, delivery, Bridge, and Runtime events.
The central service creates the opaque `trace_...` identity when a root Message
is persisted. Replies, child Runs, durable delivery payloads, and sequenced Run
events inherit it. Bridges must echo a non-empty value on ACK, status, output,
activity, reply, and handoff events. The server rejects an absent, invalid, or mismatched value;
it never infers a missing value from the Run. A terminal local inbox record with
incompatible trace metadata is isolated before recovery and never replayed. An
incompatible active record fails closed and remains available for explicit
operator reconciliation instead of being silently discarded.

`GET /api/traces/{traceId}` executes one ordered SQL query across persisted
Message, Run, Delivery, and Run Event metadata. The caller must be a member of
the owning Room, and the response deliberately excludes prompts, replies,
credentials, and local paths.

Structured logs include stable identifiers, state transitions, latency, and
error codes but exclude secrets and full prompts. Malformed JSON, a parsed
envelope rejected by boundary validation, and a failure after authenticated
processing begins use separate event names; none logs the raw payload. Metrics
cover connection health, queue depth, delivery age, retries, Run outcomes, and
event lag.

`QA-010` evidence must distinguish one logical Wave from its committed member
execution slots and from physical Runs that actually exist. It correlates
`discussionId`, `waveId`, `turnId`, `runId`, and `orchestrationKey` and asserts
one barrier-close budget event, without recording prompts or replies.
`agentRunsUsed` counts persisted expected-member slots, including a slot that
becomes unavailable before Runtime start; existing Run counters expose actual
persisted fan-out. This baseline does not claim a new production Wave metric or
aggregated member token/cost telemetry.

Codex and Generic Runtime process errors may report a bounded category, numeric
exit code, and whether stderr was present. Bridge and authenticated WebSocket
tests seed secret-like stderr and unknown detail keys, then prove only the
three-field allowlist reaches Run-event persistence.

Health endpoints distinguish process liveness, dependency readiness, and
degraded optional capabilities. Audit records are durable and access-controlled.

The supported central Compose entrypoint keeps Server port 3000 private and
publishes HTTPS through Caddy on configurable external port 9443 by default.
Port 80 remains an ACME and redirect-only listener; redirects use the exact
configured public origin so a non-default HTTPS port is never discarded.

`OPS-001` is verified by contract fixtures, migration tests, forged-trace
negative tests, restart persistence tests, and the real Server-to-Go-Bridge
Generic Runtime E2E.

`OPS-002` exposes the following operational surfaces without prompts, reply
content, credentials, headers, request bodies, or local paths:

- `GET /api/health/live` proves the process event loop is responding.
- `GET /api/health/ready` returns `503` when SQLite is unavailable.
- `GET /api/health` reports `ready`, `degraded`, or `unavailable`; an enabled
  managed Agent with no active Bridge is degraded, while no managed Agent is
  `not_configured` rather than unhealthy.
- `GET /api/metrics` emits Prometheus text for HTTP status classes, active
  Bridges, enabled managed Agents, queued Runs, pending delivery age, retries,
  Run outcomes, Agent Presence, and active Run event lag.

HTTP completion/rejection, Bridge connect/disconnect, Delivery ACK, Run state,
and Run reply processing emit structured JSON fields. Runtime output and error
messages are never log fields.

| Failure | Dashboard signal | Default interpretation |
| --- | --- | --- |
| Database unavailable | readiness `503`, `agentroom_up 0` | page immediately |
| Managed Bridge absent | health `degraded`, zero Bridge connections | investigate connectivity |
| Queue not draining | queue depth plus oldest delivery age rising | investigate routing/Bridge |
| Delivery instability | delivery retry total rising | investigate ACK/network loss |
| Runtime failures | `failed` or `outcome_unknown` Run totals rising | inspect trace metadata |
| Active Run stalled | Run event lag rising | inspect Runtime and cancellation |
| Request rejection burst | HTTP `4xx`/`5xx` counters rising | inspect auth/client/server errors |

## Release Evidence

A task is `DONE` only when its completion evidence in `docs/TASKS.md` exists.
Release notes name migrations, compatibility changes, security impact, and the
exact checks run. Evidence is tracked by `QA-001` through `QA-012`. Operations
work is tracked by `OPS-001` through `OPS-005`.

The current security and exported-tree evidence is recorded in
`docs/acceptance/qa-005-security-clean-room-audit.md`. Its PASS applies only to
the documented trusted Owner deployment boundary and lists remaining release
constraints explicitly.

The trusted-team container, proxy, backup, and restore acceptance is recorded
in `docs/acceptance/ops-004-data-005-compose.md`. It separates local TLS smoke
evidence from public certificate issuance and records the exact negative and
large-database recovery checks.

Room tail synchronization, failed-Run diagnostic projection, legacy Runtime
preset migration, and explicit Bridge self-test evidence is recorded in
`docs/acceptance/qa-012-room-bridge-ux.md`.

`QA-013` verifies the Bridge execution gate with deterministic same-Agent FIFO,
cross-Agent parallel, duplicate, queued-cancel, and reconnect cases. Runtime
start counts are authoritative evidence that queued or duplicate work did not
escape isolation. Passing evidence is recorded in
`docs/acceptance/qa-013-agent-concurrency-isolation.md`.

The operator-facing Compose lifecycle and static configuration evidence is
recorded in `docs/acceptance/ops-005-compose-operations.md`. It covers bounded
container logs, CI rendering, first setup, health, troubleshooting, upgrades,
safe stop, off-host backup expectations, and version-aligned rollback without
claiming public ACME or high-availability evidence.

A Bridge release begins as an empty draft candidate and builds from the exact
requested tag. The workflow requires five CLI archives, two native macOS GUI
archives, one native Windows GUI preview archive, one Windows current-user
installer, one checksum file, and four top-level license files. It verifies
names, versions, archive layouts, installer metadata, launchers, licenses, and
checksums before upload, then downloads the candidate and repeats the same
verifier. Native Windows CI also executes install, upgrade, and uninstall smoke
tests. Existing assets are never silently replaced.

For `v0.2.0`, stable release admission means the version-aligned Server, Web,
contracts, and Bridge are the supported baseline for trusted small Teams, the
P0-P17 exit tasks are complete, and exact-source automated correctness,
security, migration, recovery, and packaging gates have no known blocker. It
does not claim signed or notarized macOS packages, automatic updates, public
internet-scale identity, high availability, credentialed provider execution in
ordinary CI, or production readiness for every environment. `BRG-013` real
macOS login-restart evidence and `QA-002` two-physical-machine evidence remain
tracked post-release operational acceptance. Their open state is visible and
must not be rewritten as passing evidence, but it does not block publishing the
trusted-small-Team stable baseline.

The first v0.2 candidate and continuous quality-gate evidence is recorded in
`docs/acceptance/qa-009-v0.2.0-rc.1.md`. It includes the failed-safe preflight,
the corrective workflow permission change, successful main CI and Release run
IDs, the public prerelease, and an independent clean-download verification.

The `v0.2.0-rc.2` release evidence is recorded in
`docs/acceptance/qa-011-v0.2.0-rc.2.md`. `QA-011` is complete because the exact
tagged source passed main CI, the draft workflow verified all 11 assets, the
candidate was published as a prerelease, and a clean public download passed the
committed verifier.

The `v0.2.0-rc.3` release evidence is recorded in
`docs/acceptance/qa-014-v0.2.0-rc.3.md`. `QA-014` is complete because the exact
tagged source passed main CI, the draft workflow verified all 11 assets, the
candidate was published as a prerelease, and a clean public download passed the
committed verifier.

The `v0.2.0-rc.4` release evidence is recorded in
`docs/acceptance/qa-015-v0.2.0-rc.4.md`. `QA-015` is complete because the exact
tagged source passed main CI, the empty-draft workflow verified all 11 assets
before and after upload, the candidate was published as a prerelease, and a
fresh public download passed the committed verifier. The acceptance retains
the separate real-login and two-physical-machine gates.

The `v0.2.0-rc.5` release evidence is recorded in
`docs/acceptance/qa-017-v0.2.0-rc.5.md`. `QA-017` is complete because the exact
tagged source passed the retried main CI jobs, the empty-draft workflow verified
all 11 assets before and after upload, the candidate was published as a
prerelease, and a fresh public download passed the committed verifier. The
acceptance records the initial E2E timeout and retains the separate real-login
and two-physical-machine gates.

The stable `v0.2.0` release evidence is recorded in
`docs/acceptance/qa-021-v0.2.0.md`. `QA-021` is complete because the exact final
tag passed main CI, the empty-draft workflow built seven archives and verified
all 11 assets before and after upload, the Release was published as the public
Latest version, and a new public download passed the tag's committed verifier.
The acceptance records both pre-publication defects and the approved zero-asset
tag rebuild instead of treating either failed attempt as release evidence.
`BRG-013` and `QA-002` remain visibly open post-release physical-environment
acceptance.

The `v0.3.0-rc.1` candidate admits the additive Bridge recovery, local consent,
Runtime discovery, Codex session guidance, browser Mention retention, and safe
Agent Runtime policy projection delivered after `v0.2.0`. Admission requires
the exact tagged source to pass main CI, the empty-draft workflow to verify all
11 assets before and after upload, public prerelease publication, and a fresh
public download verified with the tag's committed script. Migration 0039 and
the optional `runtimePolicy.filesystemAccess` projection are included in the
version-aligned Server, Web, contracts, and Bridge candidate.

The `v0.3.0-rc.1` evidence is recorded in
`docs/acceptance/qa-022-v0.3.0-rc.1.md`. `QA-022` is complete because the exact
tagged source passed main CI, the empty-draft workflow built seven archives and
verified all 11 assets before and after upload, the candidate was published as
a prerelease, and a fresh public download passed the tag's committed verifier.
The acceptance retains the separate real-login and two-physical-machine gates.

The `v0.3.0-rc.2` candidate admits the productized native Bridge navigation,
general embedded usage guidance, and explicit `preserve_and_retry` or
`start_new` Codex active-writer conflict policy. The release evidence is
recorded in `docs/acceptance/qa-023-v0.3.0-rc.2.md`. `QA-023` is complete
because the exact tagged source passed main CI, the empty-draft workflow built
seven archives and verified all 11 assets before and after upload, the
candidate was published as a prerelease, and a fresh public download passed
the tag's committed verifier. The stable Latest release remains `v0.2.0`, and
the separate real-login and two-physical-machine gates remain open.

The `v0.3.0-rc.4` candidate admits the AgentRoom Community License 1.0 and the
platform-aware Windows Runtime launcher repair. The release evidence is
recorded in `docs/acceptance/qa-025-v0.3.0-rc.4.md`. `QA-025` is complete
because the exact tagged source passed main CI including the native Windows
`codex.cmd` regression, the empty-draft workflow built nine binary artifacts
and verified all 14 assets before and after upload, the candidate was published
as a prerelease, and a fresh public download passed the tagged verifier on
macOS. The stable Latest release remains `v0.2.0`, and physical Windows UI,
live Runtime launch, real macOS login restart, and two-machine gates remain
separate.

## Dependencies

All modules. Verification uses public contracts and avoids reaching through
ownership boundaries solely to make tests easier.
