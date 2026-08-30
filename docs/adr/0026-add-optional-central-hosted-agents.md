# ADR-0026: Add optional Central Hosted Agents

- Status: Accepted
- Date: 2026-08-30
- Supersedes: none
- Amends: ADR-0001, ADR-0003, ADR-0022, and ADR-0025

## Context

ConveneWire can currently route work to managed Agents published by a paired
Bridge, manual Agents acting through MCP, and deterministic in-process Fake
Agents used for testing. A deployment with no online Bridge therefore has no
production Agent that can answer a Mention. This makes a single-computer or
Server-only installation harder to try even when the owner only wants a remote
model response and does not need local code or computer control.

Installing a second Agent Host, sidecar, image, process, or Pi/Codex executable
would raise the deployment threshold and duplicate lifecycle ownership. Letting
the Server scan its host for Pi, Codex, workspaces, or credentials would also
turn the Central control plane into an implicit machine-execution boundary.

The desired capability is narrower: after Central starts, an Owner may
optionally configure a model provider in the Web UI and create an Agent that
uses an outbound HTTPS model API. An installation that never configures this
feature must behave exactly as it does today.

## Decision

### 1. Keep the Hosted executor inside the existing Central Server

The released Server process gains a `HostedModelAdapter` module. It is ordinary
Server code in the existing Central image, not a new service, container, image,
daemon, executable, or Bridge mode. It calls an explicitly supported remote
model provider over HTTPS and projects the response through the existing Run
event and reply boundaries.

Central does not search `PATH`, inspect host applications, start Pi or Codex,
execute a shell, mount a Workspace, read arbitrary files, control a desktop,
connect to a Docker socket, or inherit a Bridge's local Runtime authority. Work
that needs those capabilities continues to require an owner-configured Bridge
Agent.

The feature is absent by default. Server startup, database migration, Web
authentication, health, readiness, Bridge pairing, managed Agents, manual
Agents, and Fake acceptance do not depend on a provider configuration or
provider reachability.

### 2. Add a distinct `hosted` Agent integration mode

A Hosted Agent has the same immutable `agentId`, Team scope, Room roster,
display name, role, enabled state, Run history, and Mention identity as another
Agent, but it has no `deviceId` and does not publish through a Bridge. Each
Hosted Agent binds to one versioned Central-owned Runtime Profile containing a
supported provider, model identifier, credential reference, and closed
execution limits.

Creation and configuration are Team-Owner actions. A new Hosted Agent receives
no implicit Room access; the Owner explicitly selects its initial Rooms and may
later use the normal Room roster authority. This prevents enabling a remote
provider from silently exporting every existing Room's history.

Presence is derived independently of Bridge heartbeats:

- `ready`: enabled, assigned to at least one Room, configuration is complete,
  and the latest bounded provider check has not made the profile unavailable;
- `busy`: at least one accepted Hosted Run is executing;
- `degraded`: the profile is incomplete, its credential was revoked, or a
  provider check/execution reported a safe availability failure;
- `offline`: not used to represent an enabled Hosted Agent, because there is no
  Device connection to expire; and
- disabled Agents remain historical identities and receive no new Runs.

Provider reachability is an observation, not Central readiness. A transient
provider failure may degrade the Hosted Agent but never makes the whole Server
unready.

### 3. Configure after startup and persist in SQLite

The existing Web Agent-management surface adds an optional Hosted Agent setup
flow. The Owner selects a supported provider and model, enters an API key,
performs a fixed content-free connection test, chooses name, role, and Rooms,
and then creates the Agent. The same surface can replace or revoke a credential,
change a model, disable/re-enable the Agent, and repeat the connection test.

Profiles, credential envelopes, non-secret provider metadata, configuration
versions, test observations, and invocation intents are stored in the existing
Central SQLite database. No `/data/hosted-agent-secrets` directory, standalone
`master.key`, new volume, Compose field, Docker secret, startup environment
variable, or command-line flag is introduced for this feature.

Provider credentials are write-only through HTTP. List, detail, test, error,
audit, diagnostic, log, metric, Web state, and backup-reporting surfaces never
return plaintext or a reversible masked value. SQLite stores authenticated
encryption envelopes and key/version metadata rather than plaintext API keys.
The packaged `trusted-team` deployment derives its wrapping authority from the
already required Owner recovery material with domain-separated key derivation;
it does not add new operator configuration. Local loopback mode may keep the
complete database-scoped wrapping material in SQLite for restart portability;
that prevents accidental plaintext projection but, honestly, does not protect
against theft of the whole local database. Database file permissions, backup
protection, and trusted-team recovery material remain the stronger boundaries.

When an existing local installation adopts trusted-team mode, startup must
atomically rewrap the data keys of all local keyrings under the current Owner
recovery authority while preserving credential versions, then remove the old
local-root copies from the live SQLite database and WAL before claiming completion.
Interrupted cleanup is durable and retried at startup; incomplete cleanup
fails startup closed. A wrong recovery root or incompatible mode otherwise
degrades Hosted credential availability only, leaving ordinary Central usable.
There is no silent downgrade. Previously exported backups or filesystem
snapshots retain their original local-mode boundary and are not deleted or
retroactively protected by adoption. POSIX database and backup files are private
(`0600`); newly created data and backup directories are `0700`.

Credential replacement is versioned. New Runs bind the current version while
an active Run retains its frozen version. Revocation immediately rejects new
Runs and requests best-effort cancellation of active calls without deleting
the Agent, profile history, Run history, or audit evidence.

### 4. Restrict provider transport and prompt authority

The first version accepts only code-defined provider adapters and fixed HTTPS
origins. It does not accept an arbitrary base URL, redirects to a different
origin, URL credentials, plaintext HTTP, proxy credentials, or a user-supplied
network target. Redirect, DNS, TLS, response-size, header, deadline, concurrent
request, and streaming limits fail closed. Provider response headers and bodies
are not copied into safe errors.

The adapter receives the already authorized bounded Run context. It sends only
the prompt projection needed for that Run and treats Room, Task, Message, and
provider output as untrusted text. It never receives a local path, command,
environment, Device credential, Owner recovery material, other provider key,
hidden server configuration, or raw Result authority.

The initial Hosted Agent has no tool-call executor. Provider tool requests,
computer-use requests, shell/file/network operations outside the fixed model
call, and interactive approval requests fail closed. Model text may still ask
for an exact Agent handoff through the existing reply parser; Central performs
the normal Room, target, depth, loop, deadline, and policy checks before any
child Run is created.

### 5. Persist invocation intent before crossing HTTPS

Run Orchestration creates a Hosted Run through the same authorized Mention,
handoff, or Discussion paths and persists one unique invocation intent before
the Adapter may open a provider request. The intent freezes Run, Agent,
profile/credential version, provider/model, deadline, prompt digest, and
idempotency identity without storing the plaintext credential or a second copy
of the prompt.

Crossing from durable `prepared` state to `dispatching` occurs before the first
outbound byte. Ordered provider deltas become the existing bounded
`run.output_delta` events; one final assistant response becomes the existing
transactional Agent reply and terminal `completed` event. Safe deterministic
pre-dispatch validation errors become `failed`. HTTP rejection, timeout,
malformed streaming, overflow, cancellation, and provider errors use closed
codes and never expose raw provider detail.

If Central restarts with a Hosted invocation in `dispatching` or a later
nonterminal state, provider acceptance cannot be proved. Startup recovery
therefore terminalizes the Run as `outcome_unknown` and never automatically
reissues the model call. The ordinary audited ambiguity acknowledgement and
new-Run retry rules remain authoritative. A request that never acquired an
invocation intent remains normal queued work and may be scheduled once.

Cancellation after dispatch is best effort. When Central cannot prove the
provider rejected or completed the request, it records `outcome_unknown`
instead of claiming remote cancellation. This conservative rule prevents
invisible duplicate provider charges and repeated data disclosure even though
the first version exposes no provider tools.

### 6. Keep formal Result authority out of the first version

A Hosted Agent may produce Run output, a final Room reply, exact-name handoff
text, and ordinary Discussion participation. It may not propose a formal Task
Result, review or accept a Result, acknowledge an ambiguous outcome, complete a
Task, change Team/Room/Agent access, configure another credential, or invoke a
Member-only/MCP/Device-only command.

Adding formal Hosted Result proposals requires a later accepted authority and
contract change that defines a non-Device, non-MCP Agent principal. It is not
inferred from the Server process's technical ability to call its own services.

## Alternatives

- Add a `central-agent-host` container beside the Server: rejected because the
  narrow HTTPS-only executor does not justify another image, lifecycle, secret
  exchange, health dependency, or installation step.
- Bundle or scan for Pi/Codex on the Central host: rejected because it adds
  implicit machine, Workspace, process, and credential authority and behaves
  differently across Docker and native deployments.
- Reuse a Bridge running beside Central: rejected as the default because it
  keeps the extra installation and pairing step that this feature is intended
  to remove. A user may still choose a Bridge when local execution is needed.
- Store provider keys in Compose, environment variables, or a mounted secret
  directory: rejected because configuration is optional, Team-scoped, rotated
  after startup, and must survive through the existing database lifecycle.
- Store plaintext API keys in SQLite: rejected because ordinary database
  inspection, error handling, and backup tooling should not expose a directly
  usable credential.
- Accept an arbitrary OpenAI-compatible base URL: deferred because SSRF,
  redirect, private-network, proxy, and certificate policy require a broader
  network-authority decision than the first version needs.
- Give the Hosted model Server tools immediately: rejected because a pure model
  response closes the current usability gap without introducing a second
  privileged execution platform.

## Consequences

- A Server-only installation can add a useful Agent without installing a
  Bridge or changing Docker startup configuration.
- Existing Bridge Agents remain the only path to owner-machine files, commands,
  local Runtime sessions, and computer control.
- Central now handles provider credentials and outbound prompt data, increasing
  its security, privacy, migration, backup, and observability obligations.
- Model-provider availability and cost are external dependencies of the Hosted
  Agent only, not of Central availability.
- A Server restart may conservatively lose an otherwise successful provider
  answer as `outcome_unknown`; avoiding duplicate calls is preferred to guessing
  or blind replay.
- The first version is deliberately conversational and orchestration-capable,
  but cannot close formal Result-gated work by itself.

## Compatibility and Security

The Bridge WebSocket protocol, Device publication, managed Runtime adapter,
Bridge configuration schema, CLI/Desktop packages, pairing, and release asset
matrix do not change. Existing Bridges require no update. A Hosted Run never
creates a Bridge Delivery and no Hosted credential crosses a Bridge connection.

The Central Web and Server are released together and may add `hosted` to their
authenticated Agent projections. Older durable Agents and integration modes
retain their identities and semantics. Migration 0052 is additive, preserves
all existing rows, and leaves installations with no Hosted configuration
behaviorally unchanged.

Only a Team Owner may create, configure, test, rotate, revoke, disable, or
re-enable a Hosted profile or Agent. Room membership still gates prompt data
and Mention visibility. Every endpoint revalidates Team, Agent, profile, Room,
configuration revision, and active-work fences rather than trusting browser
filtering.

No task under this ADR authorizes a production provider credential, arbitrary
outbound endpoint, Bridge modification, new deployment service, release
publication, external purchase, or formal Result authority.

## Verification

- empty, upgrade, reopen, backup, restore, and revoked-credential SQLite tests;
- authenticated encryption round-trip, tamper, wrong-authority, rotation, and
  plaintext-search negative tests;
- Owner-only, cross-Team, cross-Room, stale-revision, disabled, unconfigured,
  and active-Run authorization tests;
- fixed fake HTTPS provider tests for connection check, streaming, final reply,
  rejection, timeout, redirect, malformed stream, output overflow, and
  cancellation;
- SSRF and credential-disclosure negatives covering URL, headers, logs, safe
  errors, diagnostics, metrics, API reads, browser state, and backups;
- ordinary Mention, exact handoff, and Discussion scheduling through the same
  Run state machine without a Bridge Delivery;
- crash cuts before intent, after `dispatching`, during streaming, and before
  transactional reply projection, proving at most one automatic provider call
  and conservative `outcome_unknown` recovery;
- explicit rejection of provider tool calls, formal Result proposal/review,
  Task completion, ambiguity acknowledgement, and Member/Device/MCP commands;
- Web component and browser acceptance for unconfigured, testing, ready,
  degraded, key replacement/revocation, disabled, and narrow-screen states;
- existing managed/manual/Fake, Bridge WebSocket, pairing, Compose, Server
  readiness, backup, E2E, build, schema, documentation, Go, race, vet, Desktop,
  and release-packaging gates remain green; and
- `QA-038` records the exact deterministic evidence without requiring a real
  paid provider credential or claiming production provider acceptance.
