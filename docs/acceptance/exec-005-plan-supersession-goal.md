# EXEC-005 Plan Supersession and Evidence Carry-Forward Goal

Status: accepted on 2026-09-03. This document was frozen before implementation
and remains the implementation and acceptance authority for `EXEC-005`;
`docs/TASKS.md` remains the sole delivery-state register.

## Goal

Allow one approved or running Execution Plan to adopt an exact next revision
without rewriting its existing history. A supersession may retain compatible
evidence only through a new revision-local `EvidenceAdoption`, after current
authorization and deterministic reuse checks. A narrowly bounded Agent
delegation may activate a low-risk candidate; every broader change waits for a
Task Owner or Team Owner.

This slice answers three questions:

1. how an active Plan records and activates its next immutable revision;
2. when old proof may explicitly authorize a node in that revision; and
3. which changes may use prior human delegation instead of fresh human review.

It does not let an LLM select arbitrary work, mutate a repository, weaken a
verification or integration gate, or infer evidence reuse from similar text.

## Supersession Lifecycle

An active Plan may retain at most one pending next-revision candidate:

```text
current approved revision rN
  -> immutable candidate rN+1
  -> exact human or delegated activation
  -> current approved revision rN+1
```

Candidate proposal is not activation. It does not move `currentRevision`,
change Plan state/control, transfer Task claims, create a Run, dispatch work,
or carry evidence. The candidate pins the current Plan revision, digest and
control revision, the current root Task revision, its author and exact frozen
decision sources. Exact operation replay returns the same candidate; stale or
competing proposals fail closed.

Initial `EXEC-005` supersession keeps the compiled Task set fixed. Every
candidate node names one already-claimed existing Task, and every current
claimed Task appears exactly once. Node keys may change and edges may be
rewired, but adding, removing or replacing Tasks requires another Plan. This
conservative boundary avoids disguising Task creation or cancellation as graph
maintenance while still permitting real topology, assignment, scope, budget,
verification and integration-policy revisions under human authority.

Activation is one immediate transaction. It freezes the candidate as the next
Plan revision, compiles exact node/edge snapshots, transfers each current Task
claim to the matching next-revision node, retains the activation receipt and
selected carry-forward adoptions, advances `currentRevision` and
`controlRevision` exactly once, and preserves the prior non-terminal Plan
state. Any failed check rolls back all of those facts.

## Immutable In-Flight History

Supersession never edits or deletes a prior DispatchIntent, Run, manifest,
input binding, workspace lease, Result, receipt, adoption or node projection.
An already-authorized prior-revision Run may finish as historical work, but it
does not materialize or settle the new revision. Current-revision admission for
the same Task stays blocked until that older Run reaches a terminal, non-
ambiguous state. An unacknowledged `outcome_unknown` remains a blocker.

If a current Task already has adopted evidence, activation must explicitly
carry every retained gate for that Task to its matching next-revision node.
This prevents a Plan from stranding a Task whose accepted Result cannot be
recreated. Nodes without retained evidence may execute normally after the old
attempt fence clears.

## Explicit Evidence Carry-Forward

Carry-forward is an activation selection, not an inferred scheduler behavior.
Each selection pins:

```text
target nodeKey + gate
source adoptionId + adoptionDigest
source reuseContractId
source nodeReuseContractDigest
source reuseInputEvidenceDigest
```

The service re-reads the immutable source, proof, adoption and reuse companion;
rejoins the target node, Task snapshot, policy and logical input producers;
rechecks current local Agent/grant/profile and proof authority; and computes a
new target reuse contract. Carry is allowed only when both of these semantic
digests equal the retained source values:

```text
nodeReuseContractDigest
reuseInputEvidenceDigest
```

It is forbidden to decide reuse with `contractDigest`, `adoptionDigest`,
`nodeContractDigest`, `resolvedInputSetDigest`, node key, Result ID, Artifact
ID or commit ID. A changed repository/base, input producer, scope, output,
Agent, grant/profile pin, required verification, integration target, Task
definition/criterion/assignment or logical Artifact digest therefore blocks
carry.

A successful carry retains a new immutable target-revision
`EvidenceAdoption` and a new companion `EvidenceReuseContract`, both pointing
back to the source adoption/reuse facts in their supersession authority. It
does not copy or relabel source evidence or proof. Dependency and input readers
continue to consume revision-local adopted materializations through the
existing adoption-first projection.

The initial Core slice carries only locally produced evidence. Optional Remote
Evidence remains supported in its existing revisions but cannot be carried by
`EXEC-005`; enabling that path requires a separate product decision and
provider-specific current-authority rules.

## Bounded Replan Delegation

A Task Owner or Team Owner may issue one immutable Plan-local delegation to one
exact assigned Tech Lead Agent. It pins the current Plan revision/digest/control
revision, a monotonically increasing delegation revision, an expiry, and the
fixed compiled Task set. Revocation is append-only and exact-digest bound.
Issuing, revoking or expiring a delegation never changes a Plan by itself.

Delegated activation is one-shot and succeeds only when a deterministic
comparison proves all of the following:

- the same Task set, node contract identities, Agent assignments,
  repository/binding/base, grants/profiles, scope, input/output slots,
  required flags, verification profiles and integration targets remain;
- root, Plan and node budgets do not increase, `maxConcurrency` does not
  increase, and no permission or integration authority broadens;
- every carried adoption passes the exact reuse checks above; and
- the delegation is current, unexpired, unrevoked, owned by the proposing
  Agent and unused.

The delegated change may reorder or rewire compatible unmaterialized nodes and
may reduce budgets. Any other difference returns
`EXECUTION_HUMAN_REVIEW_REQUIRED` without partial revision, claim, adoption,
Run or delegation-consumption facts. A current Task Owner or Team Owner may
activate a broader candidate within the fixed-Task-set boundary after exact
review; human authority still cannot relabel incompatible evidence.

## Public Boundaries

The authenticated HTTP surface adds candidate read/propose/activate plus
delegation issue/list/revoke operations. Human mutation requires the current
root Task Owner or Team Owner, exact Plan/root/control pins, same-origin Web
protection and bounded closed payloads.

The assigned Tech Lead MCP surface may propose a supersession candidate using
the same exact own-Run/context authority as `team.propose_plan_revision`. It
may request delegated activation only through the current one-shot policy; it
cannot create a delegation, claim human review, approve incompatible carry,
cancel work or mutate Git.

Central continues to govern Plan, evidence and operation receipts only.
Repository paths, credentials, worktrees and Git commands remain Client/Bridge
authority under ADR-0039.

## Non-Goals

This slice adds no new Task creation/removal during supersession, automatic
retry, automatic LLM replanning, Discussion participant selection, quorum,
Web graph editor, remote-provider carry-forward, GitHub/GitLab adapter, PR,
webhook, push, merge or repository command. It does not make
`EvidenceReuseContract` a capability token.

## Required Evidence

`EXEC-005` may become `DONE` only when contract, physical SQLite and service
evidence proves all of the following:

1. a candidate is immutable, replayable, exactly `current + 1`, and proposal
   alone changes no current revision, control, claim, Run or adoption;
2. exact human activation atomically advances revision/control, preserves Plan
   state and transfers the fixed Task set, while stale and competing activation
   have one winner;
3. old Runs/manifests/inputs/workspaces remain byte-identical, and an active or
   ambiguous old-revision attempt blocks new admission for the same Task;
4. compatible accepted, verified and integrated local evidence each retains a
   new target adoption/reuse companion and releases the matching dependency;
5. carry compares only the two reuse digests and rejects changed input,
   criterion, base, scope, output, verifier, Agent, grant/profile, integration
   policy/target and substituted source/proof/adoption pins;
6. omission of any already-adopted Task gate rejects activation without partial
   facts, while historical source/proof/adoption rows remain unchanged;
7. current unexpired delegated authority accepts only a one-shot low-risk
   topology/budget-narrowing candidate and records the exact Agent, issuer and
   delegation digest;
8. expired, revoked, stale, reused, wrong-Agent and privilege/budget/criteria/
   scope expansion all escalate to human review without consuming delegation;
9. restart and response-loss replay preserve the exact candidate, activation,
   adoption and delegation receipts; injected failures roll back the complete
   transaction;
10. closed TypeScript/Go contracts, migrations, focused Server/MCP/HTTP tests,
    full workspace build/regression/E2E/Bridge/docs gates and three isolated
    temporary-lifecycle rounds pass with physical before/after zero counts for
    all four historical temporary prefixes.

A passing supersession unit test alone is not acceptance. Final evidence must
include exact revision/claim/adoption rows, immutable prior-run snapshots,
restart/concurrency results and physical temporary-directory snapshots.

## Accepted Implementation

Migration 0083 retains immutable candidate, activation, delegation,
revocation, consumption, carry adoption/reuse and response receipt facts. It
permits Task claims and the Plan current revision to move only while the exact
same activation transaction contains the matching candidate, compilation and
approval. Existing plan/revision, approval, claim and adoption invariants stay
closed; the generalized adopted-materialization view still requires Remote
reuse/input-attestation companions and now also requires every carried reuse
companion.

`ExecutionPlanSupersessionService` separates proposal from activation. Proposal
freezes sources and the fixed existing-Task set but cannot advance Plan control,
claims, Runs or adoptions. Activation rechecks current Plan/root/control,
source, Task, Agent and local Bridge grant/profile authority, performs the
fixed-set compilation and claim transfer, advances Plan revision/control, and
retains carry and delegation consumption in one immediate transaction. Exact
response-loss replay returns the original sealed receipt.

Carry-forward re-reads the retained local SourceEvidence, proof refs,
EvidenceAdoption and EvidenceReuseContract. It rejects omitted gates, duplicate
selections, Remote Evidence, substituted pins, unavailable local authority and
changed logical inputs. The target revision receives a new adoption and reuse
companion; accepted, verified and integrated gates all release their matching
dependency reader without dispatching the carried source node again.

The Tech Lead MCP tools can propose only from a current assigned primary
Agent's exact working root Run. Delegated activation additionally requires the
latest monotonically revisioned, unexpired, unrevoked, unused Owner delegation
and deterministic no-broadening comparison. A stale, expired or revoked
delegation and a Plan-budget expansion all fail without consuming authority or
advancing the Plan.

## Acceptance Evidence

The accepted implementation is commits `bdbb967` and `53a4727` on `main`.
The following evidence was run from an isolated private temporary base on
2026-09-03:

- `npm run validate` validated 14 schemas and 258 fixtures; `npm run build`
  built Server, Web and current generated TypeScript/Go contracts.
- `npm test` passed 569 Server, 268 Web and 99 Contract tests, plus Bridge UI,
  QA evidence, local/trusted product-experience, site and 24 temporary-lifecycle
  checks. The outer run root and every nested fixture root were removed.
- `npm run test:e2e` passed nine deterministic scenarios and explicitly skipped
  only the opt-in live-Runtime scenario. Physical scenarios included two
  Bridges, exact integrated dependency bytes, response-loss/restart recovery,
  parallel CAS winner/conflict and fan-in.
- `npm run test:bridge` passed every Go Bridge package, including the long
  repository suite. E2E and Bridge ran concurrently under distinct owned run
  IDs and each removed only its own root.
- Three additional consecutive `npm run test:temp-lifecycle` invocations each
  passed 24 checks covering success, assertion/process failure, spawn failure,
  timeout, `SIGINT`, `SIGTERM`, nested ownership and parallel isolation.
- Physical snapshots before the acceptance run and after all workspace, E2E,
  Bridge and three lifecycle rounds found zero directories named
  `agentroom-*`, `agent-room-*`, `convenewire-*` or `convene-wire-*` inside the
  isolated base, and zero total entries remained in its run-root directory.

Focused SQLite/service evidence additionally proves candidate immutability and
inertness, one concurrent activation winner, restart replay, full injected
rollback, byte-preserved old history, active and unacknowledged ambiguous
prior-revision admission fences, three-gate carry, missing-gate and forged-digest
rollback, delegation revision/revocation/expiry/one-shot behavior and
human-review escalation on budget expansion. Contract semantic-drift tests
change criteria, base, scope, output, verifier, integration target, Agent,
grant/profile and Artifact digest and show that the reusable node digest changes.

## Retained Boundaries

`EXEC-005` does not create or remove Tasks, automatically retry or replan,
carry Optional Remote Evidence, edit the graph in Web, execute Git, or grant
repository authority to Central. Repository and Git remain client-owned as
stated in ADR-0039. The next Core tasks are `DISC-011`, `DISC-012`, `QA-054`
and `QA-055`.
