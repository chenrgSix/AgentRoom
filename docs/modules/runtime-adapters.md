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

The Generic CLI Adapter executes only the configured argument array in its
fixed workspace, sends the Run instruction on stdin, propagates only allowlisted
environment variables, and caps returned stdout at 20 KB. Exit failure,
deadline, cancellation, and output overflow become safe terminal Run events.
An executable start failure is distinct from a child process nonzero exit.
Codex and Generic nonzero exits include only a stable local classification,
numeric exit code, and stderr-presence flag. The central service applies the
same three-field allowlist before Run-event persistence; raw stderr and unknown
detail keys never cross that boundary.
Pi uses a dedicated parser over its non-interactive JSON event stream while
retaining the Generic process lifecycle. Preset version 2 runs `--mode json`,
no-tools, and no-session; the adapter exposes only the last completed assistant
message. The local JSON event stream is capped at 512 KB and the extracted
reply remains capped at 20 KB. Malformed JSON, a missing assistant reply, or
provider-specific raw tool-call markup fails the Run with
`RUNTIME_PROTOCOL_INVALID`; none of that stdout is published to the Room. Pi
does not gain resume or remote session claims.

The first Fake Adapter lives in the central server workspace solely for the
in-process MVP acceptance harness. It implements the same ordered request/event
shape without claiming Runtime ownership; production adapters remain in the Go
Bridge once its interface is available.

## Process and Workspace Safety

Adapters receive an owner-defined Runtime configuration, never an arbitrary
server-provided shell string. They must isolate process groups, bound output,
propagate cancellation, and clean up children. Existing Runtime command, file,
network, and approval policies remain authoritative.

## Events and Replies

Adapter events carry `runId`, `sessionRef`, sequence, timestamp, and schema
version. Text replies and structured handoff requests are filtered
for obvious credentials and sensitive local paths before leaving the machine.

Codex and Generic CLI adapters also recognize an optional final
`agentroom-assessment` XML-style envelope containing JSON. A valid envelope is
removed from the visible reply and sent as structured evidence; malformed or
unsupported output remains a normal reply. The Orchestrator, not the Adapter or
Runtime, owns the resulting continue/finish decision.

## Verification and Tasks

Shared contract tests must pass for every adapter. Runtime-specific suites cover
startup, streaming, cancellation, crash, and recovery. Work is
tracked by `ADP-001` through `ADP-006` in `docs/TASKS.md`.

The production Go boundary is `runtime.Adapter`: capability discovery plus one
context-cancelable `Execute` method that emits ordered semantic status or reply
events. The deterministic Go Fake Adapter is the first contract implementation.
The pinned Codex JSONL event subset and lifecycle limits are documented in
`docs/codex-runtime-contract.md` and guarded by Go parser fixtures.

## Dependencies

Contracts and the Bridge invocation boundary. Adapters never call Team services
directly.
