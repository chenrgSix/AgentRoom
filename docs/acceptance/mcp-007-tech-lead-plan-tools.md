# MCP-007 Assigned Tech Lead Plan Tools

Status: accepted implementation and verification evidence.

## Goal

Expose exactly three MCP tools for an explicitly assigned manual Agent:

- `team.propose_plan` creates one immutable draft;
- `team.get_plan` reads one exact draft in the same delegated scope;
- `team.propose_plan_revision` appends one immutable draft revision.

The tools use the shared closed proposal/revision commands and the existing
`ExecutionPlanDraftWriter`. They do not approve or compile a plan and do not
create Tasks, Runs, Results, verification, repository or Runtime authority.

## Tech Lead Delegation

"Tech Lead" is not inferred from the Agent's display role or instruction text.
For this bounded slice it is the conjunction of all these durable facts:

1. the MCP credential resolves to one current enabled manual Agent and its
   owning Member;
2. the root is one current top-level, non-default Task and that Agent has its
   single `primary` assignment;
3. the caller supplies that Agent's own persisted Run for the exact Task and
   Room;
4. a mutation Run is `working`; a read Run is still non-terminal;
5. the immutable Run Context Manifest pins the same Run, Agent, Task,
   Task/definition/criteria revisions, and those revisions remain current;
6. the Member and Agent still have current access to the unarchived Room; and
7. every proposal/revision cites at least one exact source from its own Run
   context: the frozen trigger Message at its Room sequence or a persisted
   event from that Run at the same sequence/revision.

Losing any fact revokes new reads and writes. Historical proposals remain
immutable evidence; they are not an authorization cache.

## Command and Attribution Rules

Create accepts `{ runId, command }`, where `command` is the closed shared
`proposalCommand`. Read accepts only `{ runId, planId }`. Revise accepts
`{ runId, planId, command }`, where `command` is the closed shared
`revisionCommand`. Unknown and permission-shaped fields fail schema admission.

The Server supplies `{ kind: "agent", agentId, runId }` as author. An Agent
cannot provide author, approval, state or an operation outside the shared
command. Root identity must equal the Run Task. Revision additionally requires
the selected draft to remain in the same exact root and Room. Shared graph,
source, external-input, Agent, repository and Task checks remain unchanged.
Exact operation replay returns the original projection; a changed replay fails
closed.

## Acceptance

The completion regression must prove:

- one assigned primary manual Agent claims its Run, creates, reads and revises
  one draft with exact Agent/Run attribution;
- create and revise replay exactly after response loss and never duplicate a
  Decision, Proposal, revision or operation;
- a role label without primary assignment, contributor assignment, foreign or
  terminal Run, stale manifest/Task revision, removed Room access, disabled or
  non-manual Agent, cross-root/cross-plan access and malformed/authority-shaped
  commands are rejected;
- no MCP approval, Result review, ambiguity acknowledgement, budget, grant,
  verification or integration tool is exposed; and
- physical SQLite counts prove proposal/revision persistence adds no approval,
  compiled node, Task, work Run, verification or integration fact.

## Completion Evidence

`ManualExecutionPlanService` now rechecks the exact durable conjunction before
every read or mutation and delegates only immutable writes to
`ExecutionPlanDraftWriter`. The MCP server exposes the three named tools with
strict wrapper schemas; proposal/revision bodies still pass the shared contract
validator. The Server supplies Agent/Run attribution and no human-authority
tool was added.

Focused MCP tests exercise one real Web-created top-level Task, manual Agent
credential, assigned Run, Context Manifest, trigger Message and SQLite
database. The Agent claims the Run, creates and exactly replays revision 1,
reads it, appends and exactly replays revision 2, then loses read authority when
the Run becomes terminal. Both revisions remain `draft` and retain the exact
same `{ kind: "agent", agentId, runId }` author.

Negative cases reject an injected approval field, changed operation replay,
Tech Lead display role with only contributor assignment, substitution of a
different own Run, stale Task/manifest revisions, removed Room access,
non-manual and disabled identities, and a plan rooted outside the delegated
Run. Tool discovery confirms there is no plan approval, Result review,
ambiguity acknowledgement, budget, repository grant, verification or
integration tool.

Physical database assertions retain one plan, two Decisions/Proposals/revisions
and two operations while approval, compiled node, verification and integration
receipt counts remain zero. Agent Task and work Run counts do not increase.
The focused MCP pair passes 8 tests, the full Server suite passes 524 tests,
Server build succeeds, and every isolated test runner reports removal of its
owned temporary root.
