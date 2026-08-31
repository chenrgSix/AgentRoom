# Agent Registry and Presence Module

- Prefix: `REG`
- Planned location: `apps/server/`
- Owns: Member, Device, Agent publication, capabilities, derived Presence

## Purpose

Registry gives every participant a stable identity and tells the Router whether
an Agent can currently accept work. It separates human ownership, physical
devices, Central-hosted profiles, published Agent roles, and runtime
implementation.

## Responsibilities

- Persist Member and Device ownership.
- Publish, update, disable, and revoke Agents.
- Validate integration mode and Runtime capabilities.
- Bind each managed Agent to exactly one active Device.
- Bind each Hosted Agent to exactly one versioned Central Runtime Profile and
  no Device.
- Derive Presence from Bridge heartbeat, Runtime status, and integration mode.
- Provide stable Agent lookup to Room, Run, MCP, and Web UI.

## Exclusions

- User authentication and device credentials belong to Security.
- Bridge connections and heartbeats are transported by Bridge.
- Run state does not become Agent Presence state.
- Runtime discovery is local Bridge behavior.

## Identity Hierarchy

```text
Member
├── Device
│   └── managed Agent
│       └── local Runtime configuration
└── hosted Agent
    └── Central Runtime Profile
```

An `agentId` is immutable. Name and role are display metadata. Reinstalling a
Device creates a new `deviceId`; it never silently inherits the old device
credential or queued managed work.

## Publication Rules

- Only the Device owner may publish a local Agent.
- `managed` requires an active Bridge and an Adapter that supports start.
- `manual` may exist without an active Bridge.
- `hosted` requires an enabled Central Runtime Profile and must not carry a
  `deviceId`, Workspace reference, or local Runtime policy.
- Capabilities are validated against the Contracts schema.
- A managed Agent that advertises Workspace leases must also publish one opaque
  Workspace reference and observed generation; neither may contain a path.
- Disabled or revoked Agents remain addressable in history but cannot receive
  new Runs.

## Presence

Presence is derived, not directly assigned:

| Status | Derivation |
| --- | --- |
| ready | managed, Bridge heartbeat valid, Adapter available, no active Run |
| busy | managed and at least one accepted active Run |
| degraded | Bridge online but Adapter unavailable or capability reduced |
| manual | integration mode is manual |
| offline | managed with expired or absent Bridge connection |
| ready | hosted, enabled, assigned to a Room, complete profile, no active Run |
| busy | hosted and at least one accepted Hosted Run |
| degraded | hosted with incomplete, revoked, or unavailable provider configuration |

Heartbeat TTL is server-configured. Network jitter may delay an offline
transition but must never produce two active Device bindings for one Agent.
An `agent.status` frame is an authenticated, connection-epoch-scoped Presence
observation for an Agent owned by that exact Device; it never mutates Run
state. A healthy Device heartbeat preserves an existing `busy` projection so
liveness traffic cannot make active work appear ready.

## Failure and Security

- Stale Bridge updates are rejected using connection epoch.
- Device revoke disables all managed Agents on that Device.
- Provider-credential revocation rejects new work for its Hosted Agents but
  never changes managed or manual Agents.
- Capability downgrade is accepted and immediately reflected in routing.
- Registry responses expose only Agents visible to the authenticated Team.

Managed Bridge publications carry a locally persisted stable Agent ID. The
server permits create or update only when Device, Owner, and Team match the
authenticated Device credential; reconnect publication is idempotent.

Managed publication may include the safe Runtime policy summary defined by
`REG-005`. The Registry persists only its closed `filesystemAccess` enum and
returns it to authenticated Team members. Omission means unreported and clears
an older value on republication, preventing a downgraded or older Bridge from
leaving a stale policy label. Unknown policy fields and values are rejected;
local paths, commands, environment variables, tools, Provider data, accounts,
and credentials never enter this projection.

An Owner may disable or re-enable an Agent through
`PATCH /api/agents/:agentId`. Disablement is fenced while that Agent has active
Run or Discussion work, preserves Room assignment and history, and remains
authoritative across subsequent managed Bridge republication.

A newly created enabled Agent is initially assigned to the Team's existing
Rooms. Room ownership may later remove that Agent independently per Room;
republication of the same stable Agent updates metadata and Presence without
silently restoring removed Room assignments.

ADR-0026 deliberately overrides that compatibility default for a newly created
Hosted Agent: it begins with only the exact Rooms selected by the Owner, which
may be an empty set. Enabling a remote provider never silently exports existing
Room history. Later Room roster changes use the same Owner authority as every
other Agent.

For `SEC-006`, the Registry also exposes durable owner-scoped provisioning
requests. A request reserves one new Agent ID and references one existing
managed template Agent on the same active Device. It is not an Agent, cannot be
mentioned or receive work, and contains no local Runtime configuration. Only
the exact Device may accept or reject it. Acceptance remains pending until that
Device publishes the reserved Agent ID; publication atomically converges the
request to `ready`, including when an acceptance result was lost, while exact
retries preserve the same request and identity. The Agent upsert and request
transition share one immediate transaction. `configuration_failed` may be
redelivered with the same identity; other rejections remain terminal.

## Central Hosted Agent Target

[ADR-0026](../adr/0026-add-optional-central-hosted-agents.md) adds the closed
`hosted` integration mode under `REG-006`. The Registry owns the durable Agent
identity, enabled state, profile binding, explicit Room participation, and
derived Presence; Security owns credential plaintext/envelopes, Runtime
Adapters own the provider HTTP lifecycle, and Run Orchestration owns dispatch
and terminal outcomes.

A Hosted Agent never becomes managed because a Bridge publishes the same ID,
and a managed/manual Agent cannot be converted in place to hosted. Changing
integration mode requires a new Agent identity so history and credential
authority cannot be reinterpreted. Profile replacement is revision-fenced and
new Runs freeze the current revision. Disablement and profile mutation retain
the existing active-work fence.

Provider connectivity is a bounded observation. It can project one Hosted
Agent as degraded, but it is neither a Device heartbeat nor Central health.
Unconfigured installations contain no Hosted Agent and preserve current
Presence behavior.

Only membership in an unarchived Room satisfies Hosted Room availability.
Participant/settings and Room lifecycle mutations refresh affected Hosted
Agents after commit. A transition from no usable Room to a usable Room may
restore ready state, but an unrelated Room edit does not erase a persisted
provider-execution failure.

## Verification

- Reconnect converges publication without duplicate Agents.
- Expired heartbeat produces offline status.
- Revoked Device cannot publish or renew Presence.
- Same display name remains unambiguous through Agent IDs.
- Managed/manual/hosted capability combinations are validated.
- A Hosted Agent has no Device, no implicit Room access, and no Bridge
  heartbeat; credential revocation and provider degradation cannot affect
  Central readiness or another integration mode.

## Task Mapping

`REG-001` through `REG-005`, with pairing in `BRG-002` and `SEC-001`.
`REG-006` adds the ADR-0026 Hosted identity and Presence boundary.

## Dependencies

Contracts, Persistence, and Security. Bridge heartbeats are inputs, not registry
state authority.

## Member-aware Device ownership

ADR-0035 separates the pairing issuer from the Device owner. Explicit approval binds an existing member or atomically creates one ordinary member; multiple Devices can reuse that immutable membership. New Agents from member-aware Devices receive only the approved initial Room defaults. Existing Device/Agent attribution is not silently rewritten.
