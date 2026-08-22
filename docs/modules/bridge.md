# Local Bridge

## Scope

- Prefix: `BRG`
- Planned location: `bridge/` and the server Bridge endpoint
- Owns: outbound connection, local delivery inbox, connection epoch

The Go Bridge is an optional local companion for managed Agents. It maintains
one outbound connection to the central server and adapts accepted Run commands
to local Runtime Adapters.

## Responsibilities

- Pair the device, store its credential, and establish the outbound channel.
- Publish local Agents and Runtime capabilities.
- Maintain heartbeat, connection epoch, and reconnect backoff.
- Persist incoming deliveries before acknowledging them.
- Deduplicate deliveries and forward each accepted Run exactly once locally.
- Stream sequenced status, text replies, and handoff requests to the server.

The Bridge does not store Team history, choose target Agents, authorize
cross-member actions, or provide a GUI.

The Go 1.26.7 process accepts a strict JSON configuration. Runtime commands are
argument arrays, workspaces are absolute paths, environment propagation is an
allowlist, and non-loopback server URLs must use HTTPS.

## Connection Lifecycle

The initial transport is `/ws/bridge`. After TLS connection, the Bridge sends a
versioned hello containing its device identity, connection epoch, Agents, and
capabilities. The server either accepts the session or returns a structured
incompatibility or revocation error.

Only the newest authenticated epoch may deliver work. Reconnect uses capped
exponential backoff with jitter, republishes capabilities, and resumes from the
last acknowledged server cursor.

`GET /ws/bridge` authenticates the Device bearer credential before upgrade.
Every connection must start with protocol `1.0` `bridge.hello`; a newer epoch
closes the old socket, while stale epochs and identity-mismatched heartbeats are
closed without updating Presence.

## Durable Inbox and ACK

The Bridge writes `deliveryAttemptId`, `idempotencyKey`, payload hash, and local
status before ACK. A duplicate returns the existing acceptance and cannot start
a second Runtime process. If recovery cannot determine whether a process
finished, the Bridge reports `outcome_unknown` rather than guessing.

The MVP inbox uses one owner-only, fsynced JSON record per Run under `dataDir`.
Acceptance is serialized, verifies both idempotency key and payload hash, and
survives process restart before the Bridge sends `run.accepted` sequence 1.

## Local Safety

Device credentials use OS-protected storage when available. The Bridge starts
only Runtime configurations explicitly published by the owner and never
bypasses the Runtime's command, file, network, or approval policy. Logs exclude
tokens, credentials, sensitive local paths, and full environment snapshots.

## Verification and Tasks

Tests cover pairing, reconnect, epoch replacement, ACK loss, duplicate
delivery, restart recovery, and revoked devices. Work is tracked by `BRG-001`
through `BRG-005` in `docs/TASKS.md`.

## Dependencies

Contracts, Registry publication, Security pairing, and Runtime Adapters.
