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
- `team.list_task_artifacts` reads structured Task result evidence.
- `team.report_task_artifact` publishes one workspace-local evidence reference.
- `team.wait` waits for the next relevant Team event from a supplied cursor.

`team.get_context`, `team.get_messages`, `team.send_message`, and `team.reply`
are implemented against the same Room authorization and persistence services as
the Web API. Writes are attributed to the authenticated manual Agent, never to
its owning Web user.
Artifact tools use the same Room and Agent authorization. They transfer only
bounded references and summaries; local filesystem content and access authority
remain outside MCP and the central Server.

Read-only resources may represent Room history, a thread, or an Agent inbox.
Tool schemas must be imported from `packages/contracts/`.

### Task work-model target

[ADR-0022](../adr/0022-make-task-run-and-result-the-primary-work-model.md)
adds `team.list_assigned_tasks`, `team.get_task`, `team.list_task_results`, and
`team.propose_result` for a manual Agent. Reads remain limited to Tasks in the
Agent's current assignments or its own Run history in Rooms it may still access.
A proposal must pin the current definition and criteria it evaluated, cite a
persisted event from one of that Agent's own assigned Runs, use only the closed
source/evidence kinds, and carry a stable operation identity. Retry returns the
same immutable Result.

These tools do not expose human review, Task completion, Owner reassignment,
assignment replacement, ambiguity acknowledgement, or budget extension. They
route through the same Task service as HTTP and managed Bridge proposals; MCP
authentication never substitutes for Room, Task, Run, or evidence authority.

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
is tracked by `MCP-001` through `MCP-006` in `docs/TASKS.md`.

Manual Agents use `team.get_mentions` and `team.get_run` to inspect assigned
Runs, `team.claim_run` before longer work, and `team.complete_run` or
`team.fail_run` to publish a terminal result. `team.handoff` asks the central
service to create a guarded child Run; the MCP client never contacts another
Agent directly.

## Dependencies

Contracts, Team/Room, Task Collaboration, Run Orchestration, Registry, and
Security.
