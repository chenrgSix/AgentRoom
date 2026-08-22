# MCP Server

## Scope

- Prefix: `MCP`
- Planned location: `apps/server/`
- Owns: MCP transport, Team tools and resources, bounded wait requests

The MCP server is the low-change integration boundary for Codex and other
clients. It exposes Team capabilities and never attempts to push work into an
attached client session.

## Responsibilities

- Authenticate MCP clients and bind each request to a member and Team.
- Expose Room context, messages, mentions, replies, handoffs, and Run status.
- Support both manual participation and managed execution through a Bridge.
- Negotiate the supported MCP protocol version and optional capabilities.

The module does not own Room data, routing decisions, Runtime processes, or
device credentials. Those belong to Team/Room, Run Orchestration, Runtime
Adapters, and Security respectively.

The initial transport is stateless Streamable HTTP at `POST /mcp`, implemented
with the production v1 TypeScript SDK. Each manual Agent receives a separately
revocable bearer credential; only its SHA-256 hash is persisted. MCP credentials
are not Web sessions and cannot be used on browser APIs.

## Initial Surface

Names remain lowercase and namespaced:

- `team.get_context` and `team.get_messages` read Room state.
- `team.get_mentions` lists pending work for the current Agent.
- `team.send_message` and `team.reply` publish structured messages.
- `team.handoff` requests a child Run through the orchestrator.
- `team.get_run` reads projected Run state.
- `team.wait` waits for the next relevant Team event from a supplied cursor.

`team.get_context`, `team.get_messages`, `team.send_message`, and `team.reply`
are implemented against the same Room authorization and persistence services as
the Web API. Writes are attributed to the authenticated manual Agent, never to
its owning Web user.

Read-only resources may represent Room history, a thread, or an Agent inbox.
Tool schemas must be imported from `packages/contracts/`.

## Participation Modes

In manual mode, a client calls `team.get_mentions` or `team.wait`, then decides
whether to act. One `team.wait` call blocks only until a relevant event or a
server-defined timeout and returns the next cursor in both cases. The client or
Skill invokes it again; no conversation remains permanently blocked. In managed
mode, the server routes accepted work to an online Bridge. An MCP connection
alone does not provide remote wake-up and must never be advertised as doing so.

The implemented wait is bounded to 100 milliseconds through 30 seconds. A call
without a cursor establishes the current Room position; later calls return up
to 100 newer messages or a timeout carrying the unchanged cursor.

## Failure and Security Rules

- Authorize every tool against Team membership and Agent ownership.
- Bound long-poll duration and return a resumable cursor on timeout.
- Reject unknown schema versions and unsupported capability requests.
- Treat tool content as untrusted input and redact secrets from logs.
- Make write tools idempotent when an `idempotencyKey` is supplied.

## Verification and Tasks

Contract tests cover every tool and resource, while integration tests cover
authorization, long polling, retries, and capability downgrade. Delivery work
is tracked by `MCP-001` through `MCP-005` in `docs/TASKS.md`.

Manual Agents use `team.get_mentions` and `team.get_run` to inspect assigned
Runs, `team.claim_run` before longer work, and `team.complete_run` or
`team.fail_run` to publish a terminal result. `team.handoff` asks the central
service to create a guarded child Run; the MCP client never contacts another
Agent directly.

## Dependencies

Contracts, Team/Room, Run Orchestration, Registry, and Security.
