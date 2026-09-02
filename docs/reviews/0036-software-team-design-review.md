# Software-Team Execution Design Review

Date: 2026-08-31. Scope: ADR-0036 and its owning module contracts, checked
against repository baseline `05e70d0`. This is the implementing agent's explicit
design review, not an independent reviewer or implementation acceptance.
Delivery state is recorded only in `docs/TASKS.md`.

## Review Method

Read the supplied proposal, current v0.2 baseline, ADRs 0016/0022, Task/Run/Result
implementations, same-Task evidence constraints, Workspace read-lease service,
Discussion barrier/finalization, module ownership and existing acceptance
requirements. Challenge each proposed authority, transition, cross-domain input
and crash cut before admitting implementation. Existing code is evidence of the
starting point, not evidence that the new features are already delivered.

## Findings and Design Resolutions

| Finding | Consequence | Resolution in the accepted design |
| --- | --- | --- |
| R1: proposed TaskAttempt and TaskEvidence overlap existing authorities | conflicting completion, retry and evidence histories | reuse Task/Run/Result/Artifact; Execution owns graph coordination only |
| R2: a dependsOn edge says nothing about delivered input | downstream may use wrong code or bypass cross-Task authorization | gate-specific immutable output receipts and explicit destination-Run input bindings; preserve existing Result triggers |
| R3: approval of a mutable plan permits changed work under old consent | scope/budget/criteria drift or duplicate child creation | immutable normalized digest, exact-version approval, transactional compilation and operation fingerprint |
| R4: central capability or worktree is mistaken for OS permission | arbitrary local writes or false isolation claims | explicit owner-local grants, runtime enforcement capability, post-run scope gates distinguished from preventive access |
| R5: independent local checkout locks do not serialize a shared repository | two Bridges can promote the same target concurrently | separate logical repositoryId from local bindingId; global target lock and exact old-object CAS |
| R6: uploaded test JSON is mistaken for verified execution | Agent can manufacture completion evidence | verifier-owned operation and exact code/profile receipt, separate from claims/review/acceptance |
| R7: retrying external effects after response loss duplicates work | repeated PR creation, push or merge | durable intent, exact remote lookup and preserved outcome_unknown |
| R8: soft barriers conflict with terminal Run late-event rejection | reopening terminal Runs or mutating sealed evidence | separate bounded supplemental submission with frozen Run/Device identity; retain actual Run lifecycle and current authorization |
| R9: execution can bypass graph gates through existing Task APIs | direct mention/retry/legacy update starts unapproved work | one shared execution admission port across every work-creation/completion path |
| R10: Phase 1 runs writers before Phase 2 isolation | parallel writes and uncollectable changes | isolation/grants precede governed Run dispatch; all three increments remain required for final closure |
| R11: code review pipelines are added to Discussion | execution and deliberation become one state machine again | code pipelines stay in Task DAG; Discussion efficiency changes are read-only and optional |
| R12: schema/tests alone are treated as product acceptance | hidden process/browser/side-effect gaps | real temporary Git, actual Go Bridge, verifier commands, fault injection, Web flows and final requirement audit |
| R13: foundational API tasks also require their downstream integration acceptance | implicit execution-input/integration and repository/admission dependency cycles, even if the listed dependency graph is acyclic | explicit EXEC-006 and REPO-004 foundation tasks; original EXEC-003/REPO-001 retain complete acceptance after real downstream adapters; QA-052/QA-053 require those closures |

### R13 Implementation-Order Review

On 2026-09-01, reviewed current source and task evidence at `6f842e8`:

- EXEC-003's accepted-result port exists, but its complete gate resolvers need
  VER-001/REPO-002. REPO-002 needs EXEC-004, which needs RUN-018; requiring all of
  EXEC-003 before RUN-018 makes those completion conditions circular.
- REPO-001's local Git/checkpoint primitives exist, but its owner-visible
  production cleanup/admission connection needs BRG-071/RUN-018. Requiring that
  entire lifecycle before BRG-071 produces the same problem.
- EXEC-006 isolates the accepted-result foundation acceptance. RUN-018 can
  integrate it while unsupported independent gates continue to fail closed.
  EXEC-003 still requires the real independent resolvers and two-Bridge flow.
- REPO-004 isolates local Git/output primitive acceptance, including remaining
  producers. BRG-071 owns actual local grant/enforcement/cleanup setup; RUN-018
  owns Delivery connection. REPO-001 still requires the full production-wired
  lifecycle and is explicitly required by QA-052. QA-053 also requires EXEC-003.

The split changes implementation prerequisites, not product scope or authority.
Original task IDs and historical evidence remain; no incomplete requirement is
removed or relabeled DONE. The scoped software-team graph has 29 unique tasks,
15 known completed external prerequisites and no cycle. Both foundation tasks'
direct prerequisites are complete. The check treats older completed prerequisites
as external boundaries rather than parsing deferred prose as dependency edges.
303-file Markdown lint and whitespace checks pass for the owning-document
updates. Runtime, browser and final direction gates remain
mandatory; this review is not their acceptance.

## Important Starting-Point Corrections

- `AgentTaskRecord` already has human ownership, canonical criteria, revisions,
  assignments, budget and completion Result. Run is already an attempt with
  explicit retry lineage. Neither is a new aggregate in this design.
- `ResultService.review` restricts acceptance to Task/Team Owners. A Tech Lead
  or Reviewer role does not change that authority.
- Migration 0045 rejects foreign-Task Artifact evidence. The input binding
  extension must be a new bounded read/provenance contract, not removal of this
  trigger or synthetic copying of accepted claims.
- `WorkspaceLeaseService` implements only `read_source`; worktree/write modes
  are not implemented merely because their names exist in documentation.
- `ResultService.proposeOrchestrator` exists, but Discussion does not use Result
  acceptance as plan authority. The later `DISC-010` implementation instead
  retains one non-executing Discussion-authored plan draft from an exact closed
  finalization envelope; human approval remains separate.
- Existing Room checkpoints summarize context; they are not repository or
  process recovery snapshots.

## Review Outcome and Implementation Constraints

The design can guide implementation after the above resolutions. Acceptance of
ADR-0036 authorizes additive implementation, not modification of live user
repositories, external PRs or deployment. Tests and product use must still
obtain their explicit local and external operation authority.

Implementation should start with shared closed plan contracts and deterministic
validation, then immutable persistence/approval, local isolation, ordinary Run
integration and observable user workflows. Static and runtime checks must prove
that every legacy admission path is fenced before enabling graph scheduling.
No unimplemented capability may be advertised by a Bridge or shown as ready.

The final audit must revisit EX-01 through EX-14 and each task's stated evidence.
Missing actual Runtime/browser/native/provider evidence must be named and cannot
be converted into a passing gate by adding a manifest or source-only test.
