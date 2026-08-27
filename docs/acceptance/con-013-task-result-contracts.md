# CON-013 Task, Run, Result, and Workbench contract acceptance

Date: 2026-08-28

## Boundary

The authoritative additive work-model schema is
`packages/contracts/schemas/work/task-result.schema.json`. It defines wire
shape only. Task transitions, authorization, source existence, revision CAS,
idempotency, and transactionality remain owned by the Server domain services.

The schema separates client assignment input from the audited assignment
projection, carries explicit Task/definition/criteria revisions, and exposes
closed lifecycle, scheduling, completion-policy, budget, attention, and next
action values. A retry is a distinct Run attempt with a new Run ID, attempt
number, and optional predecessor. An `outcome_unknown` acknowledgement is an
explicit operation with Task-revision CAS.

Each Run Context Manifest freezes the Task goal and criteria plus selected
opaque context identities, comparison revisions, target capabilities, and
bounded permissions. It explicitly lists omitted ambient categories and has no
field for a local path, command, environment value, credential, provider
session, hidden reasoning, or copied tool payload.

Result proposals are immutable input records over exact opaque evidence
references: Run event, Artifact, Message, Memory, or Discussion. Claims pin the
Task definition and criteria revisions. Corrections cite the superseded Result;
review is a separate member command with revision CAS. Manual and managed Agent
envelopes identify their actor kind, Agent, and assigned Run without receiving
review or Task-completion authority.

## Verification

- `npm run validate --workspace @agent-room/contracts` validates 9 registered
  schemas and 98 positive/negative golden fixtures.
- `npm run generate --workspace @agent-room/contracts` deterministically
  generates checked-in TypeScript and Go Task/Run/Result/Workbench types.
- `env GOCACHE=/private/tmp/agentroom-go-cache npm test --workspace
  @agent-room/contracts` passes four JavaScript contract tests, generated-file
  drift checking, strict TypeScript checking, all generated Go packages, and
  the Go fixture validator.
- Negative fixtures reject local paths, provider credentials and sessions,
  copied or unknown evidence payloads, assignment audit fields, ambiguous Agent
  actor kind, lifecycle authority in review input, and unbounded Workbench
  pages.

## Deferred owning-service evidence

This closes CON-013 only. TASK-012/TASK-013, RUN-012, MCP-006, BRG-044, and the
Web tasks must still prove persisted revision semantics, authorization,
idempotency, frozen delivery manifests, human review, and UI behavior. Contract
validation alone is not runtime or end-to-end acceptance.
