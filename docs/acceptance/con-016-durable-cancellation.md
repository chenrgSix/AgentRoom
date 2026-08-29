# CON-016 durable managed cancellation acceptance

- Date: 2026-08-29
- Scope: deterministic local implementation evidence
- Result: PASS

## Authority boundary

For a managed Run already accepted by a Runtime, sending an interrupt over one
socket is not evidence that the Runtime stopped. Central must retain one durable
intent until the frozen Delivery Device reports an authoritative terminal Run
event. Reconnect, restart and ambiguous socket delivery may repeat the command,
but may not create another identity, restart work or infer `canceled`.

This change reuses the released protocol 1.0 `run.cancel_requested` command and
sequenced terminal status. It does not introduce a competing cancellation ACK
message or claim native Windows process-tree execution.

## Implementation evidence

- migration 0050 stores one immutable intent per Run with stable message,
  Agent, accepted Device, requester, reason and acknowledgement deadline;
- request persistence commits before the first send, and startup plus bounded
  sweep/hello/publish/heartbeat retry the same identity;
- a terminal Run event atomically resolves the pending intent, while a missed
  deadline becomes `outcome_unknown` with `RUN_CANCEL_ACK_TIMEOUT`;
- a pending intent freezes terminal authority to the accepted Device even if
  the Agent publication moves elsewhere;
- Bridge active-Run cancellation compares Run, trace and Agent before
  interrupting; after local completion it replays only a matching durable
  terminal inbox record and never invokes the Runtime again.

## Fault and negative regressions

- process loss after intent commit but before send recovers on reopen;
- socket delivery followed by response loss retains one message ID and intent;
- duplicate user requests and repeated reconnect sends do not duplicate state;
- a replacement Device cannot acknowledge the frozen Run;
- terminal acknowledgement stops later replay;
- a matching cancel received before its Run request durably fences admission
  and may emit a sequence-1 pre-admission `canceled` terminal status with zero
  Runtime starts;
- when Central has already accepted or started a Run, existing sequence/state
  authority prevents that sequence-1 pre-admission status from replacing the
  authoritative outcome; absent a matching terminal result, the intent reaches
  `outcome_unknown` at its deadline;
- active/non-terminal identity mismatches fail closed and do not interrupt a
  different worker;
- loss of the first terminal write on an otherwise live connection converges
  when Central repeats the cancel command.

The stable identity guarantee applies to Central's durable
`run.cancel_requested` envelope. A Bridge pre-admission terminal response may
be regenerated after an ambiguous successful socket write and therefore does
not claim a stable response message ID or timestamp across that crash cut;
Run ID, trace, Agent, terminal payload and sequence remain the convergence
authority.

## Verification boundary

Server build/full tests, Bridge full tests, focused Go race tests, vet and the
repository-wide gates recorded by `QA-036` cover the local implementation.
Native Windows Job Object execution remains `QA-036`; publication and physical
two-machine acceptance remain separately authorized work.
