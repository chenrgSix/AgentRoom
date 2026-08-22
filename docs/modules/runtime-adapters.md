# Runtime Adapters

## Scope

- Prefix: `ADP`
- Planned location: `bridge/internal/runtime/`
- Owns: Runtime discovery, process/session lifecycle, capability reporting

Runtime Adapters translate the stable Bridge contract into a specific local
agent runtime. The adapter boundary isolates Codex and CLI lifecycle changes
from the Team protocol.

## Adapter Contract

Each adapter implements versioned operations for:

- discovery and capability reporting;
- starting or resuming a Runtime Session;
- streaming ordered status, output, and handoff events;
- interrupting and disposing a session;
- recovering observable state after Bridge restart.

Capabilities declare `invocationMode: managed | manual` plus support for start,
resume, streaming, interrupt, and handoff. Unsupported operations must be
hidden upstream rather than emulated silently.

## Initial Implementations

`FakeAdapter` is deterministic and drives contracts, retries, races, and E2E
tests. The Codex native adapter is the preferred managed path, but targets a
pinned machine-readable schema/version and requires contract tests. A generic
CLI adapter is the L2 fallback with reduced lifecycle and resume guarantees.
Pull-only participants remain MCP clients and are not remote-wake capable.

## Process and Workspace Safety

Adapters receive an owner-defined Runtime configuration, never an arbitrary
server-provided shell string. They must isolate process groups, bound output,
propagate cancellation, and clean up children. Existing Runtime command, file,
network, and approval policies remain authoritative.

## Events and Replies

Adapter events carry `runId`, `sessionRef`, sequence, timestamp, and schema
version. Text replies and structured handoff requests are filtered
for obvious credentials and sensitive local paths before leaving the machine.

## Verification and Tasks

Shared contract tests must pass for every adapter. Runtime-specific suites cover
startup, streaming, cancellation, crash, and recovery. Work is
tracked by `ADP-001` through `ADP-005` in `docs/TASKS.md`.

## Dependencies

Contracts and the Bridge invocation boundary. Adapters never call Team services
directly.
