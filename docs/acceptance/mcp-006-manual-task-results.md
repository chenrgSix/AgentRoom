# MCP-006 manual Task and Result acceptance

Date: 2026-08-28

## Delivered boundary

The Remote MCP surface now exposes four lowercase namespaced tools:

- `team.list_assigned_tasks`
- `team.get_task`
- `team.list_task_results`
- `team.propose_result`

Every call starts from the authenticated, enabled manual Agent credential.
Readable work is limited to current explicit assignments, the permanent default
Task in a current Agent Room, or a Task in that Agent's own Run history. The
owning Member and Agent must both retain access to the same unarchived Room.
Task display numbers are presentation only; every read uses the opaque Task ID.

`team.propose_result` accepts the strict CON-013 shape, binds the actor from the
credential rather than input, and routes through the same TASK-013 service as
managed and Member proposals. The proposal must cite a persisted event from the
declared Agent-owned Run and pass current assignment, Team, Task revision,
definition, criteria and closed evidence-source checks. A stable operation ID
returns the same immutable Result after response loss.

The MCP tool registry exposes no Result review, Task completion, Owner change,
assignment replacement, block resolution, ambiguity acknowledgement or budget
extension command. A manual Agent may report evidence and recommend an outcome;
only an authorized human command may accept it or complete the Task.

## Negative and recovery evidence

The MCP HTTP regression authenticates a real manual credential, creates one
Task owned by another Agent, and proves it is absent from assigned work and
denied by direct Task read. It reads its own completed Run Task and Artifact
evidence, submits a Result with that Run's terminal event, retries the exact
proposal, lists the same Result and verifies every human-authority tool name is
absent.

## Verification

- `npm run build --workspace @agent-room/server` passes strict TypeScript.
- `npx tsx --test apps/server/test/mcp-auth.test.ts
  apps/server/test/task-result-service.test.ts` passes four focused tests.
- `npm test --workspace @agent-room/server` passes 146 Server tests.
- `npm run lint:docs` passes the maintained Markdown corpus.

This closes the manual MCP transport only. Browser work queues and human review
remain owned by `WEB-046` and `WEB-047`.
