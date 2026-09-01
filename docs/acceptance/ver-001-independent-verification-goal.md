# VER-001 Independent Verification Goal

Date: 2026-09-01

This record froze the next bounded vertical slice after EXEC-007. Delivery
state remains authoritative only in `docs/TASKS.md`. The target below is
unchanged; the final delivery and physical acceptance evidence are recorded in
the Delivery Evidence section.

## Target Outcome

One approved two-node plan advances through an independently proven edge:

```text
implementation A --verified_output--> implementation B
```

A still runs through the existing generation-1 governed Runtime and canonical
repository capture. After the exact checkpoint exists, the Bridge resolves one
or more required owner-local verification profiles, asks Central to admit an
exact `verify` repository operation, and runs each profile in a separate child
process against the captured candidate. Central retains an immutable
`VerificationReceipt` for every admitted operation. Only the complete set of
required `passed` receipts for the same candidate may produce a revision-local
`verified_output` NodeMaterialization and release B through the existing
`ExecutionDependencyResolver` and `freezeForRun()` transaction.

An Agent Result may cite the candidate Artifacts, but neither its prose nor a
`test_result` Artifact is verification authority. Human Result acceptance is
also not a prerequisite for `verified_output`; the gate authority is the exact
independent receipt set.

## Frozen Ownership

| Fact | Sole authority in this slice |
| --- | --- |
| candidate commit, tree, input and output Artifact pins | canonical `RepositoryCheckpoint` |
| allowed verifier command, environment names and limits | immutable owner-local verification profile |
| permission to verify this plan/node/candidate | current Task grant plus Central verification operation admission |
| process exit, timeout, cancellation and bounded sanitized log | Bridge verifier process journal and receipt submission |
| trusted verification conclusion | authenticated immutable `VerificationReceipt` |
| downstream consumable output for `verified_output` | revision-local NodeMaterialization backed by all required receipts |

Central never accepts a trusted receipt through Agent Result, MCP, Artifact or
ordinary member APIs. The only local authority in this increment is the exact
paired Bridge Device named by the admitted operation. CI authority remains a
wire-compatible future adapter and is not simulated by this work.

## Exact Profile and Process Boundary

An owner registers a verification profile explicitly on the Bridge. The local
record pins its profile ID, revision 1, canonical digest, executable identity,
argument vector, safe inherited environment-name allowlist, timeout and output
limit. Paths, environment values, credentials and commands never leave the
host. Registration is not a Task grant and does not run verification.

At admission and again immediately before process start, the Bridge requires:

- the exact unrevoked profile ID/revision/digest required by the manifest and
  local Task grant;
- a current unrevoked `verify` operation in that grant;
- the exact repository/binding, plan revision, node, Run, Device, checkpoint,
  candidate commit/tree and input digest;
- an existing captured candidate whose Git commit and tree still equal the
  checkpoint; and
- a deadline bounded by the Run, workspace and grant expiry.

The verifier receives a minimal environment plus a run-owned temporary root for
`HOME`, `TMPDIR`, Go caches and npm cache. It receives no deployment credential
or Agent Runtime session state. It executes in the isolated candidate worktree,
not the owner source checkout. Cancellation terminates the owned process group;
timeout has a distinct `timed_out` outcome. A possibly started process whose
terminal result cannot be proven becomes `outcome_unknown`, never `passed`.
The run-owned temporary root is removed on pass, failure, timeout, cancellation,
spawn error and parent return.

## Operation and Receipt Lifecycle

For each required profile, the Bridge derives one stable
`RepositoryOperationRequest` with action `verify`. Central admits it only after
matching the current frozen manifest and canonical checkpoint and retains the
exact request digest before the local command starts. Reusing an operation ID
with different content conflicts.

The receipt reuses the existing CON-021 `VerificationReceipt` contract and pins:

- operation and request digests;
- exact plan and execution scope;
- repository, binding and Bridge Device authority;
- candidate commit/tree and input digest;
- profile ID/revision/digest;
- start/finish time, duration, outcome and exit code; and
- the bounded sanitized verification-log Artifact when a trustworthy log was
  retained.

Receipt rows and their exact response bytes are immutable. On a lost submission
response, the Bridge looks up the receipt for the same operation. It never
blindly reruns the command. A missing receipt after a possibly started process
remains `outcome_unknown` until the retained local journal can submit that same
terminal fact. Foreign Devices, ordinary Agents and members cannot create or
replace receipts.

## Verified Materialization

This slice does not weaken or redesign the delivered `accepted_result` record.
It adds the parallel gate-specific proof required by `verified_output`:

- exact plan revision, source node, generation-1 Run and source Result;
- exact checkpoint, candidate commit/tree and input digest;
- sorted canonical checkpoint output Artifact pins; and
- the complete sorted required verification ID/receipt-digest set.

The source Result may remain `proposed`; it is used only to preserve the existing
source-result and Artifact selection identity. Every selected Artifact must be
both Result evidence and an output of the verified checkpoint. A passed receipt
for another profile, Run, candidate tree, input digest or plan revision cannot
be adopted.

`ExecutionDependencyResolver` remains a read-only adapter. It selects the
materialization matching each edge's exact gate. `ExecutionInputService` remains
the final transaction, authorization, sealed-byte and destination-manifest
authority. Its frozen binding records `gate = verified_output` and the receipt
set digest; it must not call the accepted-Result review resolver for this gate.

## Required Failure and Recovery Evidence

| Cut | Required result |
| --- | --- |
| profile missing, changed or revoked | no process start, receipt or materialization |
| grant lacks `verify`, is expired or revoked | no process start |
| candidate commit/tree/input differs from checkpoint | admission fails closed |
| command exits zero | one immutable `passed` receipt with safe bounded log |
| command exits nonzero | one immutable `failed` receipt; downstream remains blocked |
| command exceeds deadline | process group is stopped; `timed_out`; downstream remains blocked |
| cancellation races with exit | one retained trustworthy outcome; never coerced to passed |
| executable spawn fails | no false pass; exact terminal failure evidence is retained |
| receipt response is lost | exact receipt lookup succeeds without another command run |
| receipt submission cannot be resolved | `outcome_unknown`; no materialization |
| Agent/member forges a receipt | rejected before persistence |
| Server restarts after receipt commit | receipt is reused and one materialization is derived |
| multiple required profiles | all must pass for one materialization |
| concurrent reconciliation | one receipt per operation and one materialization |
| B admission fails after selection | no partial B binding, manifest, lease or Run side effects |

The decisive acceptance inspects physical SQLite rows, retained log bytes,
candidate Git objects, process absence and isolated temporary roots. It runs a
real Server and Go Bridge verifier path for pass, failure and timeout, injects a
lost receipt response, proves restart and concurrent reconciliation, then runs
one real `verified_output` A-to-B patch transfer. Unit tests or schema validation
alone are insufficient.

## Delivery Evidence

VER-001 is delivered by commits `6c4b057`, `5bb0862`, `84513a2`, `24a87f0`,
`e599340` and `1940796`. Together they provide the owner-local profile registry,
Central admission and immutable receipt/log authority, real isolated verifier
execution, revision-local `verified_output` materialization, exact dependency
selection and final sealed-byte authorization. `accepted_result` remains a
separate proof path. At the VER-001 acceptance boundary, `integrated_commit`
still failed closed and remained assigned to REPO-002.

The Central regression set proves that a proposed Agent Result and one passed
profile do not release the edge, a failed receipt stays blocked across restart,
all required passed receipts create exactly one materialization, two independent
Server processes reconcile to the same row, and B receives the exact pinned
patch bytes without a Result review. Direct SQL mutation and deletion of the
retained materialization fail.

The cross-process acceptance compiles the real Go repository and admission test
binaries, captures an actual Git candidate, runs separate pass, nonzero-exit and
timeout verifier child processes, drops the successful receipt response, and
recovers it with the exact receipt lookup. It physically asserts three admitted
operations and three immutable SQLite receipts, reads every retained log Blob by
digest and length, proves the timeout child never reaches its completion marker,
proves the owner source commit and worktree are unchanged, and observes an empty
verifier temporary parent after return.

The final commands and results were:

- `npm test --workspace @convene-wire/server` — 499 tests passed; the owned
  `convene-wire-test-run-*` root was physically removed.
- `npm run test:bridge` — every Bridge package passed, including repository,
  admission and verification; the owned test root was physically removed.
- `npm run test:e2e` — seven deterministic E2E cases passed; the explicitly
  opt-in live-model case remained skipped and is not claimed by VER-001.
- `npm run validate` — 11 schemas and 243 fixtures validated.
- `npm run build` — Server, Web and generated contract checks passed.
- `npm run lint:docs` — 322 maintained Markdown files passed after this final
  evidence update.
- The real Server/Go verification acceptance was run three consecutive times
  with `CONVENE_WIRE_TEST_RUN_BASE` pointing at one isolated temporary parent.
  Every run passed 6 tests, emitted its own cleaned run root, and the four
  historical leak-name snapshots were `before=0` and `after=0`.

This VER-001 evidence does not claim live-model verification, remote CI
authority, repository integration or a physical two-Bridge verified Git
handoff. Later tasks may independently close those boundaries.

## Explicit Non-goals

VER-001 itself did not implement `integrated_commit`, repository target mutation,
remote CI/PR authority, independent human review admission, generation 2, plan
supersession, scheduler modes, Web graph UX, live-model acceptance or physical
two-Bridge Git handoff. It does not change the source node to a generic
`completed` state. UI projection remains a later task.
