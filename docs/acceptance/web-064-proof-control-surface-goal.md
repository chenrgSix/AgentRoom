# WEB-064 Proof Control Surface Goal

Status: frozen on 2026-09-03 before implementation. `docs/TASKS.md` remains
the sole delivery-state register. This goal presents and controls already
delivered verification, adoption and integration authority; it may not invent
proof, infer success or mutate a repository in the browser.

## Goal

Add one Server-backed **Evidence** surface to the canonical Task detail so a
human can answer, for every current execution node:

```text
where did this candidate come from?
which verification or CI proof was retained?
why is the gate open or closed?
who explicitly adopted or approved it?
what happened to repository integration?
what exact action is safe now?
```

Local Bridge producers and authenticated remote producers share one visual
proof chain:

```text
SourceEvidence
    -> GateProofRef(s)
    -> EvidenceAdoption
    -> NodeMaterialization
    -> IntegrationApproval
    -> IntegrationReceipt
```

The Server owns this projection and every next-action reason. The Web renders
facts and submits explicit commands; a green icon, candidate commit, CI label,
browser role or cached response is never execution authority.

## Authoritative Read Model

Add one bounded, Task-scoped page:

```text
GET /api/tasks/:taskId/execution-evidence?limit=50
```

It first authorizes the current Task Room, then returns only current-revision
plans whose durable `rootTaskId` is the requested Task. Each plan/node entry
must bind:

- plan ID, revision, digest, control revision and state;
- node key, compiled Task, runtime state, blocker, generation and current Run;
- required verification profiles and their exact retained local verification
  or remote CI receipts;
- source evidence kind, origin, commit/tree and ordered sealed Artifact pins;
- every retained adoption with gate, actor/service, proof-set digest and exact
  adoption/source digests;
- integration target, verified materialization, human approval, operation and
  terminal receipt when each exists; and
- one closed next-action code with an owning actor and safe explanation.

The projection excludes credentials, provider response bodies, URLs other than
the already configured public provider origin, local paths, commands, logs,
workspace references and raw SQLite diagnostics. Unknown/corrupt joins fail the
whole affected node closed instead of showing a partial success chain.

## Explicit Commands

The surface may expose two owner-only actions when the Server returns their
exact readiness template:

1. adopt one authenticated remote source as `verified_output`; and
2. approve one local verified candidate for exact-target integration.

Remote adoption binds the current plan revision/digest/control revision,
provider binding, node and source evidence. Integration approval binds the
verified materialization, candidate commit/tree, input digest, ordered
verification receipt pins, target ref and expected target commit. The browser
adds only a stable operation ID and an explicit confirmation; it may not edit
the Server template.

Each command is retained in identity/Task/plan/node-scoped tab session storage
before submission. An unknown network result shows **check authoritative
state** before **retry exact command**. A structured 4xx/409 clears the pending
command; a transport loss keeps it. Selection, plan revision, session, Task or
member changes synchronously hide stale facts and invalidate confirmation.
Storage failure blocks new commands.

The integration operation still executes only on the authorized Bridge. The
Web approval does not run Git, claim the target moved or synthesize a receipt.
Conflict, failure, cancellation and `outcome_unknown` remain retained facts
with different guidance:

| State | Web guidance |
| --- | --- |
| proof missing/failed | inspect the exact profile/receipt; produce new evidence |
| remote adoption ready | owner may explicitly adopt this exact proof set |
| integration approval ready | Task/Team Owner may approve the exact target CAS |
| integration pending | wait for or recover the owning Bridge operation |
| target conflict | refresh/replan; never retry as if the old target were current |
| `outcome_unknown` | inspect the exact target/receipt path; never claim success |
| integrated | show expected, candidate and resulting target commit plus receipt |

## Remote Producer Boundary

REPO-003 remote nodes remain input-free. This surface may display that closed
admission reason but must not provide a bypass for an incoming graph edge.
`REPO-005` owns a future `RemoteInputAttestation` companion that pins both the
exact source adoption authority and the logical input evidence digest. Git
`baseCommit` ancestry alone is insufficient because an input may be a patch,
document, report or test evidence rather than a commit ancestor.

Remote provider credentials remain runtime-only. Web does not configure or
persist them. `SEC-014` owns outbound DNS/address policy before Team Owners can
supply credentials or a live provider adapter may be accepted.

## Interaction And Layout Acceptance

- The canonical Task tab list adds **Evidence** without replacing Plan, Runs,
  Results, Artifacts or Audit.
- Nodes and stages are keyboard navigable and expose text labels in Simplified
  Chinese and English; color and icons are never the only status signal.
- Long IDs/digests wrap or use bounded local scrolling. At 1280, 720 and 390
  pixel widths neither the document nor the Evidence surface overflows.
- Artifact bytes remain behind the existing authorized preview/input paths;
  the proof page shows only immutable pins and explicit inspection links.
- Empty, partially progressed, failed, remote and integrated plans all produce
  truthful distinct states. No synthetic fixture may auto-adopt or integrate
  merely to make the screenshot green.

## Required Evidence

Completion requires:

1. contract fixtures and generated TypeScript/Go round trips for local and
   remote node proof projections, closed next actions and exact command
   templates;
2. Server tests for Task/Room authorization, current-revision scoping, bounded
   ordering, local verification, remote CI/adoption, integration success,
   conflict, failure, `outcome_unknown`, corruption and zero-mutation reads;
3. Web tests for source/proof/adoption presentation, owner-only command
   confirmation, response-loss recovery, exact retry, stale/selection/session
   fencing, safe text rendering, locale/theme and keyboard behavior;
4. a real Server plus production Web browser acceptance at 1280, 720 and 390
   widths covering one local integrated node, one remote adopted node and one
   blocked/recovery state without exposing secrets or local paths;
5. full contracts, Server, Web, workspace build, deterministic E2E and docs
   gates; and
6. three isolated temporary-lifecycle rounds with physical before/after zero
   counts for `agentroom-*`, `agent-room-*`, `convenewire-*` and
   `convene-wire-*`.

## Explicit Non-goals

This goal does not execute verification, mint CI proof, automatically adopt
evidence, run Git, retry a Bridge operation, resolve a target conflict, accept
remote-node inputs, configure provider credentials, add live GitHub/GitLab,
allow remote push/PR merge/webhooks, implement scheduler modes or fairness,
supersede a plan, carry evidence to another revision, or complete QA-053.
