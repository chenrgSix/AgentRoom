# QA-055 Final Governed Execution Core Audit Goal

Status: accepted on 2026-09-03. This document was frozen before implementation
and is the implementation and acceptance authority for `QA-055`;
`docs/TASKS.md` remains the sole delivery-state register.

## Goal

Audit the delivered Governed Software-Team Execution Core against the complete
accepted ADR-0036 design, its recorded review resolutions and EX-01 through
EX-14. Repair every in-scope correctness, authority, recovery or documentation
finding before declaring the Core complete. Report Optional Remote Evidence
Extensions separately and do not make provider availability a Core exit gate.

## Audit Method

For every EX requirement, the audit must identify:

- the current owning implementation and authority boundary;
- contract and migration facts;
- focused positive, negative, replay/restart and concurrency evidence;
- product/E2E and physical evidence where the requirement calls for it;
- retained platform, live-provider, live-model, deployment and Release limits;
- any finding, its severity, repair commit and post-repair evidence.

Documentation claims must be checked against current code and persisted facts,
not copied from historical acceptance prose. Missing evidence is a finding.
P0/P1 Core findings must be repaired and independently regressed. Lower-risk
deferred work must be explicitly outside the accepted Core boundary or remain
open in `docs/TASKS.md`; it cannot disappear into narrative.

## Required Final Inventory

The accepted record must provide a requirement-by-requirement EX-01..EX-14
matrix, the current Core and Optional Extension task inventory, repair list,
exact commits, test commands/results, browser/physical acceptance references,
temporary-directory before/after snapshots and honest non-claims.

The final gate includes all registered schema fixtures and generated types,
all Server/Web/workspace tests, Bridge Go tests/vet and relevant race coverage,
deterministic E2E, production builds, documentation lint/whitespace checks and
at least three isolated temporary-lifecycle rounds with zero new
`agentroom-*`, `agent-room-*`, `convenewire-*` or `convene-wire-*` directories.

`QA-055` is `DONE` only when the audit itself is retained, every blocking Core
finding is repaired, the complete gate is green and the task register and
product boundary agree. This audit does not claim live LLM quality, real
GitHub/GitLab/CI availability, multiple physical computers, Windows/Linux
physical execution, deployment readiness, signed release artifacts or public
release admission unless separately evidenced.

## Accepted Audit Outcome

The current implementation was traced from the closed JSON Schema through
Server domain services, SQLite migrations and triggers, HTTP/MCP/Delivery
admission, Bridge local execution and Web projections. Historical acceptance
records were used only after their owning code and current regression remained
present. Every Core task in the ADR-0036/0039 route is `DONE`; Optional Remote
Evidence remains supported, tested and default-credential-free but is not a
Core prerequisite.

The audit found one P0 Core consumption defect and three P1 verification or
documentation defects. All four are repaired and regressed. No open P0/P1 Core
finding remains.

## EX-01 through EX-14 Matrix

| Requirement | Current implementation and persisted authority | Current evidence and audit result |
| --- | --- | --- |
| EX-01 | `DiscussionPlanProposalService`, `ExecutionPlanDraftWriter`, `ExecutionPlanRepository` and migration 0058 retain attributed immutable decisions, sources and non-executing proposals. | Closed-envelope, malformed-output, rollback, reopen and QA-054 quorum-to-draft cases pass. A Discussion draft has zero approval, compiled-node and dispatch facts. Closed. |
| EX-02 | `ExecutionPlanCompiler` and `ExecutionPlanService` validate the complete versioned DAG and commit child Task claims, nodes and edges under migration 0059. | Cycle, duplicate, source drift, atomic rollback, competing compilation and reopen cases remain in the 594-test Server suite. Closed. |
| EX-03 | `ExecutionPlanService` plus `ExecutionApprovalRepository` bind an exact revision/digest/root revision and current human authority; SQLite guards reject plan/claim rewrites. | Stale, foreign, changed-payload, response-loss and concurrent-winner tests pass. The controlled product E2E performs the real human approval before dispatch. Closed. |
| EX-04 | `ExecutionDependencyResolver`, `ExecutionInputService`, the three gate materializers and adoption/reuse repositories own exact cross-Task selections. Migrations 0060, 0066-0076, 0083 and 0086 retain bindings, proofs, adoptions, carry and reader authority. | QA-052/053 physically transfer exact integrated and mixed verified bytes between Bridges. QA-054 now proves carried accepted evidence reaches a revision-2 DispatchIntent after restart and ambiguity acknowledgement. F-01 repaired the previously missing carry-to-input join. Closed. |
| EX-05 | `ExecutionReadinessEvaluator`, `ExecutionScheduler`, `GovernedRunAdmissionService`, scheduler control/fairness repositories and migrations 0065, 0071-0073 and 0081 own one generation-aware intent and ordinary Run. | Offline/reconnect, two schedulers, response loss, generation 2, fan-out/fan-in, same-Agent serialization, durable cross-sweep fairness and manual/supervised/automatic mode tests pass. No automatic ambiguous retry exists. Closed. |
| EX-06 | Central retains opaque workspace and operation facts; `bridge/internal/admission`, `repository`, `runtime` and `workspace` own local binding, grant, worktree, process and cleanup authority. Migrations 0061-0064 expose only path-free pins. | BRG-071/RUN-018/REPO-001 and QA-052/053 use real Git worktrees and Bridge processes, deny missing/revoked local authority and physically remove only owned worktrees. Core Bridge race and vet pass. Closed. |
| EX-07 | `RepositoryVerificationService`, verified materializer, migrations 0067/0068 and Bridge verification profiles/runner retain independent candidate-bound receipts. | Actual pass/fail/timeout/cancel/spawn and response-loss commands, forged Device/profile/tree negatives and multi-receipt fan-in remain green. Agent prose and Result acceptance cannot create verification proof. Closed. |
| EX-08 | `RepositoryIntegrationService`, integrated materializer, migrations 0069/0070 and Bridge integration journal execute an approved exact-old-object `update-ref` CAS under separate owner-local consent. | QA-052/053 prove one exact integration, moved-target conflict, concurrent CAS winner, response-loss lookup and exact downstream bytes. No merge/rebase/push/force path is admitted. Closed. |
| EX-09 | `apps/server/src/remote` and migrations 0077-0082 retain authenticated commit/CI/input-attestation observations behind an empty-by-default credential resolver and egress policy. ADR-0039 classifies the whole surface as Optional Extension. | Retained loopback provider, outcome-unknown, DNS/rebinding/redirect and adoption-first regressions pass inside the Server suite. No live provider is required or claimed; absence cannot block Core. Closed as an optional compatibility boundary. |
| EX-10 | `ExecutionPlanPanel`, `ExecutionEvidencePanel`, `RunRecoveryControls` and their Task-authorized Server read/command services expose plan, proof, integration and recovery without moving authority into React. | WEB-063/064 retain real Server browser evidence at 1280/720/390 widths; the current 268 Web tests include exact receipts, stale selection, navigation, keyboard and narrow-layout checks. F-03 hardened cold-cache navigation waits. Closed. |
| EX-11 | `ExecutionPlanSupersessionService`/repository, migration 0083 and assigned Tech Lead MCP tools separate inert candidates, human activation and one-shot no-broadening delegation. | Exact-Agent/Run, stale/foreign, expiry/revocation/reuse, digest substitution, budget expansion and carry replay tests pass. QA-054's 13-table snapshot proves broader delegated change has no side effect. Closed. |
| EX-12 | `DiscussionParticipantSelector`, `DiscussionOrchestrator`, `discussion-quorum`, supplemental service and migrations 0084/0085 own frozen focus, quorum seals and separate late evidence. | Permutation, deadline, required Reviewer, restart, atomic rollback, live omitted Run, Bridge replay and prompt-exclusion tests pass. QA-054 produces an unapproved Plan from this path. Closed. |
| EX-13 | Existing Task/Run/Result services remain authoritative; governed admission is additive and legacy work creation cannot satisfy graph gates. | QA-052/053/054 plus the final 594 Server, 268 Web and 101 Contract runs preserve ordinary Rooms/default Tasks, human Result review and Optional Extension compatibility. F-02 repairs concurrent child-state polling. Closed. |
| EX-14 | This retained audit, the task register and current module/README boundaries are the completion authority. | F-01 through F-04 are repaired; all final schema, build, test, E2E, Bridge, race, vet, docs and physical cleanup gates below are green. Closed. |

## Design-review Resolution Audit

| Review item | Current resolution |
| --- | --- |
| R1 duplicate attempt/evidence authorities | Task, Run, Result and Artifact remain authoritative; Execution owns only Plan/graph coordination. No TaskAttempt or TaskEvidence aggregate was added. |
| R2 ordering without exact input | Every edge selects a gate-specific adopted materialization and freezes a destination binding with exact content; F-01 closes the carry-forward consumption gap. |
| R3 mutable approval | Complete immutable revisions, canonical digests, exact human review and transactional compilation remain enforced. |
| R4 capability mistaken for OS authority | Central capability is only an admission fact; current owner-local grants and Bridge-enforced workspace/runtime boundaries are independently required. |
| R5 per-checkout locks | Integration serializes logical repository/target identity and the Bridge performs exact-old-object CAS. |
| R6 uploaded test claim | VerificationReceipt is emitted by an enrolled verifier/CI authority against exact candidate and profile identity, never by Result text. |
| R7 blind external retry | Optional provider operations perform exact authenticated lookup and retain `outcome_unknown`; the behavior remains outside Core. |
| R8 soft barrier versus late terminal events | Immutable read-only quorum seals and content-free supplemental operations preserve the actual omitted Run lifecycle. |
| R9 legacy execution bypass | Governed work uses one admission service and capability-fenced Delivery; ordinary Mention/retry/Task controls do not create governed graph proof. |
| R10 isolation after writers | Local grants, worktree preparation and possible-start rechecks precede Runtime invocation. |
| R11 code review inside Discussion | Review, verification and integration remain Task DAG proof authorities; Discussion contributes only non-executing decisions. |
| R12 schema-only acceptance | QA-052/053 run real Git, Bridge and verifier processes; WEB-063/064 supply browser evidence; this audit repeats full and physical gates. |
| R13 prerequisite cycles | EXEC-006 and REPO-004 remain explicit foundations, while EXEC-003 and REPO-001 are closed only by their physical downstream acceptance. |

All thirteen recorded resolutions are present in current code and evidence. R7
is deliberately retained as Optional Extension behavior rather than converted
back into a Core dependency.

## Findings and Repairs

| Finding | Severity | Reproduction | Repair and post-repair evidence |
| --- | --- | --- | --- |
| F-01 carried accepted evidence was resolver-ready but not consumable | P0 Core correctness | The upgraded supersession path resolved revision 2, then failed input freeze with `EXECUTION_INPUT_SOURCE_UNAVAILABLE`, so no downstream Run could start. | Commit `d2382b6` adds migration 0086 and separates original ResultReview gate proof from revision-local adoption authority. The same test now reopens SQLite and retains one revision-2 downstream intent; 594 Server tests pass. |
| F-02 child-state polling treated a partial JSON write as permanent corruption | P1 acceptance reliability | Concurrent lifecycle runs observed `Unexpected end of JSON input` between child truncation and completed write. | Commit `0d75095` retries only transient `ENOENT`/`SyntaxError` snapshots until the existing deadline and adds a deterministic partial-write regression. Three final rounds pass 25 checks each. |
| F-03 real Server navigation used an unrealistically short generic wait | P1 browser acceptance reliability | Cold isolated runs could time out while resolving the authorized legacy Task even though the same navigation converged. | Commit `39cbbbb` gives this real Fastify/SQLite test file a bounded 10-second async wait. Its 11 focused cases and all 268 Web tests pass. |
| F-04 current-route prose still described completed work as future | P1 documentation correctness | README/baseline/ADR/module text still named DISC-012 and QA-054 as remaining after both were accepted. | Commit `9c74659` aligns all current route descriptions while preserving historical acceptance records. Final docs lint and whitespace checks pass. |

No P2 finding is silently deferred. Product breadth outside ADR-0039's Core is
listed below instead of being reclassified as an audit defect.

## Final Task Inventory

The completed Core inventory is:

- governance and wire: `GOV-024`, `GOV-025`, `GOV-026`, `GOV-027`,
  `CON-020` through `CON-024`;
- execution: `EXEC-001` through `EXEC-011`, including explicit foundations,
  evidence adoption/reuse, scheduler modes, supersession and carry-forward;
- local execution and proof: `WSP-003`, `BRG-071`, `RUN-018`, `REPO-001`,
  `REPO-002`, `REPO-004` and `VER-001`;
- human and Agent product path: `DISC-010` through `DISC-012`, `MCP-007`,
  `WEB-063`, `WEB-064`, and `QA-052` through `QA-055`.

The Optional Remote Evidence inventory is `REPO-003`, `REPO-005` and
`SEC-014`; all remain `DONE`, implemented and tested. They supply no default
credential and no active access without an operator-provided runtime resolver.
They are not counted as a Core prerequisite.

`BRG-013`, `WEB-050` and `QA-038` remain active product/release work outside
this Core completion claim. `FUT-*` items remain future work. Their existence
does not reduce the accuracy of the bounded Core result and is not hidden by
this audit.

## Final Verification Evidence

The audited implementation and repairs are commits `d2382b6`, `0c34a5e`,
`0d75095`, `39cbbbb` and `9c74659`, built on the accepted DISC-012 commits.
Verification on 2026-09-03 produced:

- `npm run validate`: 14 schemas and 258 fixtures passed;
- `npm run build`: Server, Web and generated TypeScript/Go contracts built;
- `npm test`: 594 Server, 268 Web and 101 Contract tests passed, followed by
  every Bridge UI, QA-evidence, local/trusted product-experience, site and 25
  temporary-lifecycle check; the outer root
  `/private/tmp/convene-wire-test-run-XRUCUP` was deleted;
- `npm run test:e2e`: nine deterministic scenarios passed and the opt-in live
  Runtime scenario was the only explicit skip. Physical tests cover the full
  controlled product loop, two Bridges, exact integrated dependency bytes,
  parallel CAS conflict/fan-in, restart and response loss;
- `npm run test:bridge`: every Go Bridge package passed, including the 310-
  second real repository suite; its isolated root was deleted;
- `go test -race ./internal/admission ./internal/connection
  ./internal/delivery ./internal/repository`: all four Core packages passed,
  including the 330-second repository race suite; `go vet ./...` passed; and
- `npm run lint:docs` and `git diff --check` passed after the final record.

Three additional `npm run test:temp-lifecycle` invocations ran under the exact
private base `/private/tmp/convene-wire-qa055-f6ELdp`. Each passed 25 success,
failure, spawn, timeout, signal, nested, process-tree and parallel-isolation
checks. Before and after counts for `agentroom-*`, `agent-room-*`,
`convenewire-*` and `convene-wire-*` were all zero; after each round the base
contained zero entries, and the owned base itself was removed.

Current browser behavior is evidenced by all 268 Web regressions plus the
retained WEB-063/WEB-064 real-Server screenshots and interaction checks at
1280, 720 and 390 pixels. QA-052 and QA-053 remain the physical local
multi-Bridge/Git references. QA-054 joins those accepted paths with the new
focused quorum and bounded supersession facts instead of fabricating another
live-provider claim.

## Final Boundary and Non-claims

The completed result is the Governed Software-Team Execution Core: an approved,
deterministically scheduled, capability-fenced and proof-carrying local
software execution graph with bounded human-governed replanning. Central
governs; Client executes; Owner controls the machine; Repository and Git remain
client-owned.

This audit does not prove live LLM quality, multiple physical computers, a real
GitHub/GitLab/CI provider, Windows/Linux physical behavior, production
deployment, signed packages or public Release admission. Remote Provider and
Hosted Agent capabilities remain separate optional products. No GitHub/GitLab
adapter, PR/webhook/push/remote-merge or provider-credential Web UI work is
implicitly authorized by Core completion.
