# Agent Registry and Presence Module

- Prefix: `REG`
- Planned location: `apps/server/`
- Owns: Member, Device, Agent publication, capabilities, derived Presence

## Purpose

Registry gives every participant a stable identity and tells the Router whether
an Agent can currently accept managed work. It separates human ownership,
physical devices, published Agent roles, and runtime implementation.

## Responsibilities

- Persist Member and Device ownership.
- Publish, update, disable, and revoke Agents.
- Validate integration mode and Runtime capabilities.
- Bind each managed Agent to exactly one active Device.
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
└── Device
    └── Agent
        └── Runtime configuration
```

An `agentId` is immutable. Name and role are display metadata. Reinstalling a
Device creates a new `deviceId`; it never silently inherits the old device
credential or queued managed work.

## Publication Rules

- Only the Device owner may publish a local Agent.
- `managed` requires an active Bridge and an Adapter that supports start.
- `manual` may exist without an active Bridge.
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

Heartbeat TTL is server-configured. Network jitter may delay an offline
transition but must never produce two active Device bindings for one Agent.

## Failure and Security

- Stale Bridge updates are rejected using connection epoch.
- Device revoke disables all managed Agents on that Device.
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

## Verification

- Reconnect converges publication without duplicate Agents.
- Expired heartbeat produces offline status.
- Revoked Device cannot publish or renew Presence.
- Same display name remains unambiguous through Agent IDs.
- Managed/manual capability combinations are validated.

## Task Mapping

`REG-001` through `REG-004`, with pairing in `BRG-002` and
`SEC-001`.

## Dependencies

Contracts, Persistence, and Security. Bridge heartbeats are inputs, not registry
state authority.
