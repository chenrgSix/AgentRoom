# Testing and Observability

## Product Experience Acceptance

ADR-0027 acceptance records first-use Central/local/demo selection, same-identity
member recovery, explicit ambiguous Run recovery, criteria/evidence review and
history pagination. Use isolated temporary data and deterministic providers;
do not use a paid model credential. Pair focused negative security tests with
production-browser checks, keyboard operation, desktop/720/390-width layout and
console hygiene. Existing Bridge, Compose, schema and migration behavior remains
in regression scope. Website publication follows this gate and is verified
separately from an application Release or physical-platform/provider admission.

`test:product-experience` verifies a temporary, Owner-bound fixture with 125
history messages, more than 100 Tasks, an unknown-outcome attempt and a real
uploaded/sealed Artifact plus proposed Result. It runs in local and trusted
Cookie modes as part of `npm test`. The explicitly enabled
`preview:product-experience` harness serves the production Web build with fresh
loopback-only databases and simulated provider responses; it neither forwards
network model calls nor reads the user's application data. The harness is not
a deployment command and removes its exact temporary data on normal shutdown.

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
- Hosted-provider E2E uses a fixed local fake HTTPS endpoint and never requires
  a paid credential or arbitrary Internet target.

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
Markdown lint, Go tests and vet, a native macOS desktop compile, and a native
Windows previous-stable-to-distinct-candidate install/upgrade/uninstall gate
with owner-state preservation. Release workflows do not replace this gate.

`QA-034` additionally makes the Release workflow self-contained at one source
identity. `validate-release` resolves the requested existing tag once to one
lowercase 40-character commit SHA and exports only that value. Separate
Repository and Go jobs check out the SHA and repeat the complete Linux CI
gates; every Bridge, Central, macOS Desktop and native Windows Desktop asset
job depends on both gate jobs and checks out the same SHA rather than the tag.
Before attaching assets and again before downloading them for verification,
the workflow resolves the tag anew and fails if it no longer names the
original SHA. The empty Draft precondition and closed release-asset verifier
remain unchanged. A local pure-policy regression rejects a changed tag, a tag-
based checkout in any downstream job, a missing Repository or Go gate, a build
that bypasses either full gate, and either missing pre-use tag check. The
`OPS-013` immutable-image jobs join that same exact-SHA dependency graph: one
OCI bundle per architecture is built and Docker-verified before all matching
Central archive jobs consume it. Policy regressions cover dependency,
source-SHA, pinned scanner, clean-daemon and artifact-consumption bypasses.
`QA-034` is `DONE`. [Hosted workflow
evidence](../acceptance/qa-034-exact-release-workflow.md) records exact-source
main CI, all 19 protected Release jobs, both Central image architectures, four
matching Central archives, native Windows stable-to-candidate upgrade, closed
22-asset verification, prerelease publication, and an independent anonymous
Windows installer/checksum download for `v0.4.1-qa034.4`.

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
machines, one verified Central/Bridge source, direct HTTPS through either the
default public CA or pairing-scoped private CA, no manual OS CA import, an
installed desktop deep link, explicit local Codex self-test, online execution,
offline queue/reconnect, exact trace reconstruction, and a sanitized committed
PASS record. The repository evidence tool reads the Server database only
through a read-only connection, accepts metrics captured inside the trusted
host boundary, cross-checks public identities and persisted sequences, requires
explicit physical attestations, rejects common credential/path/private-address
shapes, and creates rather than overwrites the Markdown record. It cannot prove
that two descriptions are physical machines or that an OS trust store was
unchanged, so human review remains mandatory. Local processes, containers and a
manual-CA reachability check cannot close this task.

Schema version 3 distinguished the Bridge version persisted by the one
consumed pairing session from the current package version persisted by the
latest authenticated hello, but did not bind the selected Runs, heartbeat or
metrics capture to that hello or the declared UTC window. A post-completion
audit reproduced acceptance with a future window, so schema-v3 records are
historical diagnostic evidence only. `QA-031` implements schema version 4: the
consumed pairing, latest current-build hello, matching live connection epoch,
fresh heartbeat, reconnect Delivery, online Run, metrics capture and explicit
human review receipt all satisfy one ordered time boundary no longer than 24
hours. The claimed metrics time must also match the snapshot file time within
five seconds. Ten focused evidence cases reject missing, stale, reordered or
mismatched components, unsafe TLS claims and unexpected Runtime console
windows. This closed the verifier defect, not the physical gate: at that
checkpoint `QA-002`, `QA-028`, and `QA-030` still required a fresh
installed-Windows schema-v4 run, while `BRG-046` had separate native and
physical evidence. The later 2026-08-30 record closes that physical gate.

`QA-035` removes two remaining formatted-claim shortcuts from that capture.
The verifier now hashes the exact versioned Windows installer itself, requires
the digest to agree with both the reviewed input and the unique entry in the
Release `SHA256SUMS`, and rejects a renamed or symlinked package. Central emits
one `convenewire_build_info` gauge from its validated v-prefixed Release version
and full source commit; development uses only the explicit
`development`/`unknown` pair. Schema-v4 capture requires the live gauge to match
the current Bridge Release and reviewed Server commit. Tests alter package
bytes, checksums, runtime source identity and duplicate/malformed evidence so
each mismatch fails before a PASS file is created.

Native Windows admission also starts with the latest published stable
installer, verifies its registered payload and protocol handlers, writes
representative owner configuration, identity and inbox files, upgrades once to
the distinct candidate, and proves their hashes survive both upgrade and
uninstall. A same-candidate double install is not upgrade evidence. The local
implementation and hosted native path passed in exact-source main CI run
`33287636198` and `v0.4.1-qa034.4` Release run `33287755768`. At that checkpoint
`QA-035` remained `ACTIVE` until a candidate's packaged Central was installed
through the controller on a target host with exact build identity and a fresh
two-physical-machine schema-v4 record bound the installed artifacts to the
observed processes. The later `v0.4.1-qa035.1` target-host and physical record
closed those external gates; hosted OCI execution, a macOS test, or source
inspection alone still does not substitute for them.

`QA-003` uses only public Web and Remote MCP endpoints. A Team Owner assigns a
root Run to Alice Agent, Alice hands off to Bob Agent, and Bob hands off to
Carol Agent. All three Agents claim and complete their Runs; the test verifies
parent lineage, one shared trace, ordered Room replies, and rejection when
Carol attempts to revisit Alice.

The recovery matrix combines server restart persistence for Run, Delivery, and
event sequence; Bridge durable inbox restart to `outcome_unknown`; duplicate
ACK and event idempotency; offline reconnect delivery; expiry; and a real
cross-process cancellation. Each case has a deterministic regression test.

`BRG-051` adds negative direct-client and Console cases in which a public-CA or
legacy-pinned credential is paired to one origin and configuration points at
another; the replacement endpoint must observe zero credential-bearing
requests. `BRG-052` adds same-process and child-process data-root contention,
borrowed-owner, symlink, drained stop/start/hot-restart/close, durable-write and
Windows Job Object parent/child/grandchild cases. Full Go race/vet and desktop
compilation are local gates. The Windows Job Object regression must also run on
native Windows before `QA-036`; a successful cross-compile is only build
evidence. The native job uses `-count=1` and verbose output so an exact run must
execute the process tree rather than restore a cached Go test result; a workflow
policy regression rejects removal of that boundary. CI run `33292642155` on
commit `ce7627a040d06d2aa4e16ebee535a8fdf3bcb5ca` explicitly executed and passed
`TestConfigureWindowsRuntimeCommandSuppressesConsoleWindow` and
`TestWindowsRuntimeJobTerminatesGrandchild` on native Windows.

`RUN-014` fault injection rejects a mentioned Run insert after Message
allocation and rejects both reply Message and reply-mapping inserts after event
application; each failure must roll back the entire immediate transaction.
Reopened-SQLite tests restore fresh and stale orphan Messages from their
original timestamps, preserve a non-runnable Task without execution, map or
create exact historical replies, and persist ambiguity/timestamp mismatch
instead of choosing a candidate. A second reconciliation produces no Runs,
Messages, mappings or failures.

ADR-0021 onboarding verification treats installation, Owner claim, Device
pairing, local Agent setup, and Runtime readiness as separate gates. Installer
tests cut execution after every durable step and prove exact reentry without a
new secret, database, data root, or Owner. Pairing tests cut create, claim,
approval, credential promotion, poll, local save, and first connection; exact
retry must converge on one Device and credential while competing attempts,
expiry, replay, enumeration, cross-Team decisions, and legacy Token mismatch
fail closed. Runtime discovery and self-test are explicit local tests rather than
evidence that pairing succeeded.

ADR-0022 work-model verification separates aggregate correctness, projection,
browser acceptance, and end-to-end completion. Task tests cover state/scheduling
transitions, Owner loss/reassignment, criteria revisions, budget admission,
Agent assignment replacement, definition drift, default compatibility,
expected-revision conflicts, and active-work fences.
Result tests cut proposal, source/claim/evidence insertion, correction, review,
accept-and-complete, and response delivery; every retry converges on one version,
decision, and Task revision. Run tests retain `outcome_unknown`, create a new ID
for a user retry, and rebuild the redacted manifest from frozen Delivery data.

Workbench tests derive simultaneous attention reasons including stale Results
and overdue Tasks, unacknowledged ambiguous Runs, plus next action from reopened
SQLite; paginate across only authorized Rooms; preserve unknown budget
telemetry; and prove cached projection state cannot authorize a command. Browser
acceptance covers Work, Task, Run, Result, review, stale-state, narrow-screen,
keyboard, focus, untrusted content, and zero-horizontal-overflow behavior.

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

ADR-0026 Hosted scenarios additionally cover an unconfigured Server, Owner-only
setup, explicit Room assignment, encrypted credential create/rotate/revoke,
content-free provider check, streaming/final reply, exact handoff, Discussion
membership, timeout, rejection, redirect, malformed output, overflow,
cancellation, and provider outage. Crash injection cuts before intent, after
`dispatching`, during streaming, and before reply projection prove one automatic
provider call at most and `outcome_unknown` after ambiguous dispatch. Negative
tests reject arbitrary/private endpoints, leaked key/header/prompt/provider
detail, tool calls, formal Result authority, Task completion, access mutation,
and any Bridge Delivery for a Hosted Run.

Transport-limit regressions service both sides of the WebSocket close handshake
before asserting client termination. Waiting only for an upgraded HTTP request
context makes cleanup depend on runner scheduling and can fail after the
greater-than-32-KiB behavior has already passed; that timing is not protocol
evidence.

The Device-onboarding release gate additionally covers clean local and direct-
HTTPS installation, public-CA default without silent fallback, explicit
origin-scoped private trust without OS CA mutation, installer reentry,
backup-before-upgrade, safe uninstall, Owner-claim response loss, public
link/QR/manual-code pairing, private link/QR pairing with short-code-only
bootstrap rejection, Server Token non-disclosure, several Agent profiles under
one Device, path-free Workspace projection, revocation before and after Bridge
acceptance, and a physical-host TLS/deep-link check. A local Compose run or
manual root import does not prove the physical-host gate.

The committed `device-onboarding.test.ts` cross-process scenario builds and
starts the real Go Bridge CLI and Console against a real TCP Server. It consumes
the canonical fragment-bearing deep link, compares the Owner and Bridge phrase,
persists one mode-`0600` Device credential without a Server Token, publishes two
path-free Agent projections, explicitly runs a managed Pi self-test, queues work
while offline, reconnects to one reply, and then verifies distinct accepted and
unaccepted revocation outcomes. This deterministic same-host evidence does not
replace the physical two-machine TLS gate.

The scenario confirms each Bridge process exited, then advances its isolated
Server clock 31 seconds before asserting the 30-second Presence TTL projection.
It therefore tests offline semantics without racing a wall-clock wait against
the same TTL boundary. A failed, canceled, expired, or outcome-unknown reconnect
Run fails immediately with its event record; a timeout reports the last observed
state and Bridge process status. This deterministic clock is test authority, not
a change to the production heartbeat interval or a product latency objective.

`QA-030` is the prerequisite trust gate introduced by ADR-0023. Deterministic
coverage must prove public-default ACME/system validation and no fallback;
closed trust-schema interoperability; fixed-path, no-secret and no-redirect
private bootstrap; CA/digest/exact-origin enforcement; owner-only state;
public-link omission; private short-code and legacy-client rejection; and
strictly increasing two-CA overlap rotation. A packaged cross-host rehearsal
then records `public_ca` or `private_scoped_ca` and confirms no OS root was
installed. Only after `QA-030` passes does `QA-002` become executable again.

The Result-gated completion release gate additionally covers current versus
stale definitions and criteria, Agent assignment changes, all required criterion
outcomes, missing/foreign evidence, concurrent accept/reject and definition-edit
races, active work, Task pause, ambiguous Run retry acknowledgement, old-client
default Task routing, legacy completed Tasks without synthetic Results, and one
physical managed Runtime whose accepted Result links to verified Artifact
evidence.

`QA-029` realizes that gate as a committed matrix rather than one broad happy
path. Focused migration, reopen, CAS and authorization regressions own the
individual cuts. Deterministic MCP E2E explicitly proposes a manual-Agent
Result, while paired-Go-Bridge E2E runs an actual local managed process,
publishes a verified Artifact and managed Result through their CLIs, ends the
active Run, then proves exact accept-and-complete replay. The physical case is
one isolated local host and does not imply the separate two-machine or
credentialed-provider gates.

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

Hosted observability adds only provider-preset/model-safe labels, configuration
state, bounded check/call latency, closed outcome codes, active-call count, and
Run identity. It never records API keys, Authorization headers, URLs beyond the
code-defined preset identity, prompts, replies, provider request IDs, account or
quota detail, ciphertext, nonce/tag, or raw response/error bodies. Provider
failure degrades the owning Hosted Agent and increments its safe failure
counter; it does not change `GET /api/health/ready`.

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
  Bridges, enabled managed Agents, queued Runs, actionable pending delivery
  age, retries, Run outcomes, Agent Presence, and active Run event lag. A
  historical unaccepted Delivery attached to a terminal Run remains traceable
  but does not inflate pending count or age. It also exposes exactly one
  `convenewire_build_info` gauge containing the validated Release version and
  full source commit; these are non-secret artifact identities, not mutable
  operator labels.

HTTP completion/rejection, Bridge connect/disconnect, Delivery ACK, Run state,
and Run reply processing emit structured JSON fields. Runtime output and error
messages are never log fields.

| Failure | Dashboard signal | Default interpretation |
| --- | --- | --- |
| Database unavailable | readiness `503`, `convenewire_up 0` | page immediately |
| Managed Bridge absent | health `degraded`, zero Bridge connections | investigate connectivity |
| Queue not draining | queue depth plus oldest delivery age rising | investigate routing/Bridge |
| Delivery instability | delivery retry total rising | investigate ACK/network loss |
| Runtime failures | `failed` or `outcome_unknown` Run totals rising | inspect trace metadata |
| Hosted provider unavailable | Hosted Agent degraded and safe provider failure total rising | inspect provider reachability/key outside logs |
| Active Run stalled | Run event lag rising | inspect Runtime and cancellation |
| Request rejection burst | HTTP `4xx`/`5xx` counters rising | inspect auth/client/server errors |

## Release Evidence

A task is `DONE` only when its completion evidence in `docs/TASKS.md` exists.
Release notes name migrations, compatibility changes, security impact, and the
exact checks run. Evidence is tracked by `QA-001` through `QA-012`. Operations
work is tracked by `OPS-001` through `OPS-005`.

`QA-038` is the deterministic ADR-0026 admission gate. It records focused
Server/Web/security/migration/recovery tests, fake-HTTPS E2E, unconfigured
Compose/readiness compatibility, existing managed/manual/Fake behavior, full
Node and documentation gates, and unchanged Bridge Go/race/vet/Desktop/package
gates. It does not claim real-provider production acceptance or authorize a
Release.

`QA-039` is the post-implementation Hosted audit closure required before
`QA-038` can complete. It adds regressions for Room revocation, cross-delta
redaction, wrapping-root adoption, probe time/capacity/cancellation, profile
mutation races, queued Responses events, recovered intent settlement,
Room-derived Presence, local file permissions and explicit Web work locks.
Its local deterministic evidence does not replace the separate browser,
physical-platform, release-package or production-provider admission gates.

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

A ConveneWire release begins as an empty draft candidate and builds from the
exact requested tag. The workflow requires five Bridge CLI archives, two native
macOS GUI archives, one native Windows GUI preview archive, one Windows
current-user installer, four Central archives, four separately published
internal-checksum pins, one outer checksum file, and four top-level license
files. It verifies names, versions, architectures, archive layouts, installer
metadata, launchers, licenses, source/schema metadata, file closure and
checksums before upload, then downloads the candidate and repeats the same
verifier. Native Windows CI also executes install, upgrade, and uninstall smoke
tests. Existing assets are never silently replaced.

New release candidates are owned by the canonical
`github.com/chenrgSix/ConveneWire` repository. GitHub redirects retained
historical `chenrgSix/AgentRoom` links, but current workflows, downloads and
independent verification use the canonical repository identity.

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

The `v0.3.0-rc.4` candidate admits the ConveneWire Community License 1.0 and the
platform-aware Windows Runtime launcher repair. The release evidence is
recorded in `docs/acceptance/qa-025-v0.3.0-rc.4.md`. `QA-025` is complete
because the exact tagged source passed main CI including the native Windows
`codex.cmd` regression, the empty-draft workflow built nine binary artifacts
and verified all 14 assets before and after upload, the candidate was published
as a prerelease, and a fresh public download passed the tagged verifier on
macOS. The stable Latest release remains `v0.2.0`, and physical Windows UI,
live Runtime launch, real macOS login restart, and two-machine gates remain
separate.

The `v0.3.0-rc.5` candidate packages the central HTTPS port 9443 and LAN IP
profile plus the Windows Desktop enrollment request-body repair. The release
evidence is recorded in `docs/acceptance/qa-026-v0.3.0-rc.5.md`. `QA-026` is
complete because the exact tagged source passed main CI, the empty-draft
workflow built nine binary artifacts and verified all 14 assets before and
after upload, the candidate was published as a prerelease, and a fresh public
download passed the tagged verifier on macOS. Physical Windows enrollment,
real macOS login restart, and two-machine gates remain separate.

The `v0.3.0-rc.6` candidate packages owner-scoped central Agent provisioning,
Bridge-local fixed and rotating management codes, mixed-version capability
gating, and same-request recovery. The release evidence is recorded in
`docs/acceptance/qa-027-v0.3.0-rc.6.md`. `QA-027` is complete because the exact
tagged source passed main CI, the empty-draft workflow built nine binary
artifacts and verified all 14 assets before and after upload, the candidate was
published as a prerelease, and a fresh anonymous direct download passed the
tagged verifier on macOS. Physical Windows provisioning, real macOS login
restart, and two-machine gates remain separate.

The `v0.4.0-qa030.1` candidate packages unified Central installation and Device
onboarding, the Task/Run/Result work model, public-CA default deployment, and
pairing-scoped private trust with acknowledged two-authority rotation.
Follow-up `v0.4.0-qa030.2` adds terminal-Delivery metric fencing and an
authenticated current-Bridge build observation for same-Device upgrades;
`v0.4.0-qa030.3` adds the Windows no-console Runtime launcher repair. Their
protected release workflows passed exact-tag CI, closed 22-asset verification
before and after upload, prerelease publication, and fresh unauthenticated
downloads verified by the tags' committed scripts.

The unpublished `v0.4.0-qa031.1` Draft was the final physical candidate. Its
[release record](../releases/v0.4.0-qa031.1.md) binds the canonical ConveneWire
repository and asset names, exact-source CI, native Windows process regression
and installer upgrade lifecycle, closed 22-asset Draft matrix, and independent
authenticated download to one exact commit. This closes the release-matrix
portion of `GOV-016`. A later installed-Windows `v0.4.0-qa031.1` Codex Run
produced output and a reply, completed normally, and opened no empty console,
closing `BRG-046`. It does not close `QA-030`, `QA-002`, or `QA-028`: a
schema-v3 physical record was captured but failed the later temporal-binding
audit, so those tasks require a fresh reviewed schema-v4 record from the same
physical Device.

`QA-033` records the Owner-authorized stable `v0.4.0` admission and publication
boundary. The [stable release record](../acceptance/qa-033-v0.4.0.md) uses the
released
`v0.4.0-qa031.1` macOS arm64 Desktop and CLI packages against a version-aligned
physical Central, a fresh dedicated Team/Room/Device, canonical Device pairing,
exact-origin scoped private trust, a real Codex app-server probe, one Run queued
while offline and completed after same-Device reconnect, and one further Run
completed on the same online connection. Exact-tag CI, Release workflow
`33231262442`, native Windows installer lifecycle, the closed 22-asset matrix,
stable Latest publication, and an independent anonymous public download all
passed. The owner-selected same-host smoke is deliberately not a schema-v4
physical record: `QA-002`, `QA-028`, and `QA-030` remain blocked and visible
after stable publication.

`QA-034` records the exact-source `v0.4.1-qa034.4` prerelease workflow. Main CI
run `33287636198` and Release run `33287755768` passed on commit
`75afb5b7d2591c2aad3c514552f737532b0af94d`; the latter closed all 19 jobs and
the 22-asset matrix. A separate anonymous download matched the public Windows
installer to `SHA256SUMS`, while public Latest remained stable `v0.4.0`.
Target-host Central execution and fresh two-physical-machine schema-v4 evidence
remain owned by `QA-035` and `QA-036` rather than being inferred from that
hosted workflow.

Those external gates later closed on exact `v0.4.1-qa035.1` commit
`152892e59e90fe17799274009141b07714262378`. A packaged macOS arm64 Central
reported the matching live build identity, native Windows CI retained the
uncached Job Object process-tree result, and the reviewed
[schema-v4 physical record](../acceptance/evidence/qa-002-20260830-schema-v4.md)
bound the current Windows Bridge artifacts, authenticated hello, pairing,
online and offline/reconnect Runs, metrics and human attestations to one
22-minute window. `QA-002`, `QA-028`, `QA-030`, `QA-035`, and `QA-036` are
therefore closed without changing stable publication state.

`QA-037` closes the separate stable `v0.4.1` publication graph. It admits the
physically accepted `v0.4.1-qa035.1` product source only because every
intervening change is documentation-only. Exact main CI `33297915641`, all 19
jobs in protected Release run `33298035386`, native stable-to-candidate Windows
upgrade, both clean-daemon Central architectures, independent pre-publication
verification, non-prerelease Latest publication and anonymous 22-asset public-
download verification passed. Candidate physical evidence is not rewritten as
stable-package execution.

## Dependencies

All modules. Verification uses public contracts and avoids reaching through
ownership boundaries solely to make tests easier.
