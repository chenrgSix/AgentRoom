# DISC-012 Read-only Quorum and Supplemental Evidence Goal

Status: active on 2026-09-03. This document was frozen before implementation
and is the implementation and acceptance authority for `DISC-012`;
`docs/TASKS.md` remains the sole delivery-state register.

## Goal

Allow an explicitly read-only Discussion to advance after a bounded soft
deadline when enough independently completed members, including every required
role, have reported. The Server must freeze the exact accepted projection while
every omitted Run keeps its real lifecycle. A late canonical reply may be
retained only through a separate authenticated supplemental-evidence operation;
it never edits the seal, progress, decision, Task Result, Plan or execution
proof chain.

Ordinary `all_settled` Waves remain the default. Quorum is a Discussion latency
policy, not a coding, review, verification, integration or Task-completion
authority.

## Frozen Policy and Admission

The resolved immutable Discussion policy adds:

```text
waveCompletionMode: all_settled | read_only_quorum
quorumMinimumCompleted: 2..5
quorumSoftDeadlineSeconds: bounded positive integer
```

`all_settled` ignores the quorum fields and preserves existing behavior.
`read_only_quorum` requires its soft deadline to be earlier than the ordinary
Wave timeout and may apply only to ordinary contribution Waves. Creation fails
closed unless every selected Discussion participant is a current managed Agent
on an active Device, advertises supplemental-evidence support and reports the
enforceable `runtimePolicy.filesystemAccess = read-only` policy. Manual,
hosted, fake, missing-policy, `local-policy` and `workspace-write` participants
cannot enter this mode. Current Room policy/roster, Task lifecycle/assignment,
Agent enablement, Device binding, capability and read-only policy are rechecked
before every later Wave; loss of authority never silently downgrades the
Discussion to all-settled or substitutes another member.

Existing Discussions migrate to explicit `all_settled` compatibility policy.
Existing Bridges that omit the additive capability continue ordinary Room,
Task, Run and all-settled Discussion behavior.

## Immutable Quorum Seal

A quorum Wave may seal only when:

1. the frozen soft deadline has passed;
2. the Wave remains open and is not a finalization Wave;
3. at least `quorumMinimumCompleted` member Turns have terminal successful Runs
   and canonical replies; and
4. the accepted set includes every role in the Wave's frozen selection
   snapshot, including the Reviewer when required.

The Server first reconciles every already-terminal member Run, then sorts the
accepted set by frozen Wave member ordinal. Callback order is not authority.
The immutable seal pins the Discussion/Wave identity, policy values, accepted
Turn/Agent/Run identities, Run reply sequences, output Message identities and
Room sequences, reply hashes, required roles, sealing time and a canonical
digest. The seal, Wave closure, one progress projection, one policy decision,
budget charge and optional next Wave commit atomically. A crash cannot retain a
seal without its decision or create two successors.

The Wave closes as a quorum-sealed partial Wave because at least one selected
member is still live. Outstanding Turns are not marked failed, canceled or
successful by the seal. Their Runs retain normal delivery, cancellation,
timeout and ambiguity behavior. A later Wave cannot select an Agent while an
older Turn for that Agent still has a nonterminal Run. If this removes a
required role or all useful participants, the Discussion waits for a human
instead of weakening the policy.

## Separate Late-evidence Submission

For an admitted quorum member, the frozen `run.requested` delivery carries a
versioned supplemental-evidence offer with a Server-created operation ID and
exact Discussion, Wave and Turn identity. A capable Bridge emits a separate
supplemental-evidence message after the Run's canonical terminal event and
references the already-retained reply sequence; it cannot upload replacement
content through this path.

The Server accepts the operation only after rejoining all of these facts:

- the authenticated current Device owns the exact Agent and original Run;
- the delivery offer, operation, Discussion, Wave, Turn and reply sequence are
  byte-for-byte consistent;
- current Agent/Room/Task/read-only/capability authority still holds;
- the Wave has an immutable seal and that Turn is outside its accepted set;
- the Run is terminal, the Turn settled successfully and the referenced reply
  and Message are canonical; and
- the operation ID is unused or is an exact idempotent replay.

The resulting append-only record pins the seal, original Device/Agent/Run/Turn,
source reply and Message sequences, reply hash, operation and evidence digests.
It is exposed separately from the sealed projection. It cannot reopen a Run,
alter a Turn outcome, change the accepted member set, feed a later prompt,
change ProgressSnapshot or create/accept a Result. Operation reuse with another
identity fails closed. Submissions for unsealed/all-settled Waves, accepted seal
members, nonterminal/failed Runs, foreign Devices or mutable/untrusted content
are rejected or recorded as a harmless non-late no-op without closing the
Bridge connection.

Normal `run.reply` ordering and terminal late-event rejection remain unchanged.
The supplemental message has no Run event sequence of its own and cannot be
used to append a post-terminal Run event.

## Projection and Recovery Rules

Room history may continue to show a canonical late Agent reply because it is a
real Run output. Discussion progress, result anchors and every later Runtime
prompt use only the seal's accepted Turn IDs for a quorum-closed prior Wave.
Supplemental evidence is visible for audit but is not automatically adopted
into the Discussion projection.

Restart recovery reuses the retained selection, seal, delivery offer and
operation identity. It may settle terminal omitted Runs and replay the same
supplemental operation, but cannot reseal, reselect, recompute a different
accepted set, double-charge budget or schedule a duplicate next Wave.

## Non-goals

This slice adds no quorum to Execution Plans, code review, verification,
integration, Result acceptance or Task completion. It adds no write-capable
quorum, automatic Run cancellation, LLM selection, repository/Git authority,
Remote Provider dependency, Plan supersession behavior, retry policy or new
human approval delegation.

## Required Evidence

`DISC-012` may become `DONE` only when focused contract, migration, service,
HTTP/WebSocket and Bridge tests prove:

1. old Discussions and clients retain all-settled behavior, while invalid
   policy ranges and every non-read-only/unsupported participant fail closed;
2. no Wave seals before its soft deadline or below threshold, and a required
   Reviewer cannot be replaced by response count;
3. the exact accepted identities/sequences/digest survive SQLite reopen and
   callback permutations;
4. seal, progress, decision, budget and successor commit atomically and remain
   idempotent through crash/recovery and concurrent callbacks;
5. omitted Runs keep real states, cannot be reused in a new Wave while live and
   later settle without changing the seal or projection;
6. a capable Bridge emits the separate operation and replay preserves its exact
   identity; the Server retains one immutable late-evidence record;
7. foreign Device/Agent/Room/Task, lost read-only policy/capability, forged
   operation/seal/sequence/content, accepted-member and all-settled submissions
   fail closed;
8. later prompts exclude late replies and supplemental evidence, while the
   audit view exposes both the frozen seal and supplemental record;
9. ordinary Discussion, Task/Run/Result, execution proof and legacy route
   regressions remain green; and
10. full schema generation/validation, TypeScript/Go builds, Server, Bridge,
    deterministic E2E, docs and isolated physical temporary-directory gates
    pass with no new residue.

A green quorum unit test alone is not acceptance. Final evidence must include
reopened SQLite seal and supplemental rows, exact source sequences/digests,
outstanding Run states, successor participant IDs, negative authority results
and physical temporary-directory before/after snapshots.
