# RUN-018 Governed Capture Delivery Increment

Date: 2026-09-01

## Scope

This increment connects one approved implementation node with no unresolved
incoming inputs to the existing ordinary Message, Run, durable Delivery and
Bridge inbox path. It derives one exact governed execution manifest and reserves
its isolated workspace before commit. It does not propose or accept a Result,
run an independent verifier, integrate a branch, complete a Task, expose local
paths or authorize cleanup.

## Server admission boundary

- Only one current `approved` or `running` plan revision may admit the governed
  Task. The compiled node, Task definition/criteria revisions, assignment,
  Message Room, target managed Agent and active Device must all match.
- Only the Task Owner or Team Owner may dispatch, and the initial path accepts
  exactly one Agent mention. Review/verification nodes, unsupported required
  outputs and nodes with unresolved required inputs fail closed.
- The Server requires the same-epoch persisted/current Agent capability and
  exactly one unexpired, unrevoked, path-free ready-grant summary. Repository,
  binding, grant, runtime profile, scope policy and verifier pins must match the
  approved node; the grant must contain exactly `prepare` plus `capture` and no
  integration target.
- Migration 0064 stages the immutable admission before the Run, using a deferred
  foreign key only inside the owned transaction. SQL triggers independently
  recheck current plan approval, Task/Room/Agent/Device ownership and exact grant
  scope. A governed Run without that staged identity is rejected.
- Run identity, context fence, capture intent, manifest digest, one-time
  admission seal and isolated workspace lease commit together. Any failure
  rolls back the Message, Run, admission and lease; no partial dispatch remains.
- The ordinary delivery record requires the sealed manifest. Immediately before
  every socket send, `BridgeConnectionRegistry` validates the generated schema
  and digest again and requires one exact current Agent grant. Capability
  downgrade, expiry, revocation, scope drift and rehashed grant expansion cannot
  reach the Bridge.

## Bridge boundary

- Local Task grant issuance, readiness publication and the governed admission
  coordinator now retain exact verifier profile pins. The pins remain checked
  by the existing local grant join but do not resolve or invoke a verifier.
- The Runtime prompt projects approved plan/node identity, repository base,
  isolated access and relative path scope, declared outputs, deadline and
  verifier pins. It states explicitly that capture is not review, verification,
  integration, Result acceptance or Task completion.
- The existing possible-start fence still owns the sole `invoke=true` decision.
  The existing governed runner still buffers a successful Runtime terminal until
  exact stopped-process proof and capture/checkpoint publication complete.

## Regression evidence

Focused tests prove:

- an authenticated Bridge hello plus same-epoch Agent publication with the exact
  grant receives one production `run.requested` carrying a schema-valid,
  digest-valid manifest;
- the admission row, frozen Context Manifest, isolated lease and durable
  delivery contain the same exact identity, while client Message replay retains
  one Run/admission;
- a foreign-plan grant returns `EXECUTION_DISPATCH_GRANT_UNAVAILABLE` and rolls
  back Message, Run, admission, lease and delivery state;
- direct SQL Run creation on the governed Task cannot bypass admission;
- changed or rehashed manifest scope cannot pass the send-time current-grant
  fence;
- existing input, migration, repository capture, capability downgrade and
  ordinary Message compatibility tests remain green;
- Bridge local grant/readiness/coordinator and prompt tests preserve verifier
  pins without creating verifier authority.

All focused Node and Go commands ran through the run-scoped temporary-root
runner, which printed cleanup of the exact owned root after each command.

## Remaining RUN-018 and product gates

RUN-018 remains `ACTIVE`: the initial production adapter intentionally supplies
no input selections, so an implementation node with required predecessor input
slots still fails closed until the EXEC-003 resolver selects exact immutable
bindings. A single real Server plus Go Bridge plus Git/Runtime same-Run acceptance
also remains required before claiming the whole path physically accepted.

BRG-071 still owns current local revocation around in-flight startup, owner setup
and cleanup surfaces, and physical no-start/start evidence. VER-001 owns actual
independent verification receipts. REPO-002 owns integration and merge CAS.
