# WEB-065 Bounded-Autonomy Product Surface

Status: goal frozen before implementation on 2026-09-03. `docs/TASKS.md`
remains the sole delivery-state register. This task productizes already accepted
`EXEC-005`, `DISC-011` and `DISC-012` authority; it adds no execution, evidence,
repository or Discussion semantics.

## Goal

Close the browser gap between the accepted governed-execution Core and the
human product surface. A Task Owner or Team Owner must be able to inspect and
control an existing Plan supersession without constructing wire commands, and a
Room participant must be able to opt into the existing read-only quorum policy
and inspect its retained seal and supplemental evidence.

The browser renders Server-owned facts and submits explicit human intent:

```text
Current Plan -> Candidate -> exact carry set -> human activation
                    |
                    `-> bounded Tech Lead delegation

Discussion draft -> advanced policy -> read-only quorum
                                           |
                                           `-> seal + late evidence audit
```

No browser label, checkbox, cached projection or client-computed digest becomes
authority.

## Page Inventory

### 1. Task Plan Replanning

Extend the canonical Task **Plan** tab for active `approved`, `running`,
`paused` and `review` plans. It must:

- show the current revision, digest and control revision separately from the
  immutable `current + 1` candidate;
- allow an authorized human to prepare a candidate from the current complete
  definition, with a required reason, through the existing closed candidate
  command;
- render a deterministic structural diff between current and candidate;
- obtain the complete carry-forward selection from a new Task-authorized,
  owner-only Server read model; the browser may display but never edit adoption,
  reuse-contract or semantic input digests;
- require an explicit confirmation and reason before exact human activation;
  the Server rechecks current Plan, Task, candidate, evidence and local
  authority in the existing atomic activation path; and
- recover an unknown response by reloading authoritative state before any new
  command. It never infers activation from a request completing locally.

The Server-prepared control projection binds the current Plan/Task identity,
candidate, full mandatory carry set and delegation states. It is a presentation
read model only. Remote Evidence carry remains unsupported and fails closed.

### 2. Task Plan Delegations

The same Plan tab must expose existing one-shot Tech Lead delegation authority:

- only a current Task Owner or Team Owner sees issue/revoke controls;
- the selectable Agent set comes only from current primary Task assignments;
- issue binds the exact current Plan revision/digest/control revision, current
  root Task revision, Agent, expiry of at most 24 hours and a required reason;
- each retained delegation displays exact identity, issuer, Agent, expiry,
  scope, revision and one Server-owned state: `active`, `expired`, `revoked`,
  `consumed`, `superseded` or `stale`;
- revocation binds the exact retained delegation revision/digest and requires a
  reason; and
- the Web cannot activate as an Agent. Delegated activation remains available
  only to the assigned Agent's existing MCP/Run authority.

Issuing or revoking a delegation does not create a candidate, activate a Plan,
carry evidence, start a Run or mutate a repository.

### 3. Discussion Policy and Evidence

Extend the Room composer and expanded Discussion details:

- ordinary multi-Agent submission keeps the current defaults;
- an explicit advanced control may select `all_eligible` or
  `question_focused`, set the focused participant limit, and opt into
  `read_only_quorum` with a minimum completed count and soft deadline;
- quorum fields are included only for an actual multi-Agent Discussion and are
  scoped with the saved Room/Task draft; clearing or sending the draft resets
  them to defaults;
- the browser warns when its current Agent projection does not show every
  selected participant as managed, Device-backed, read-only and supplemental-
  capable; Central remains the final admission authority;
- expanded Discussion details show the retained policy and each Wave's frozen
  participant-selection snapshot;
- a quorum seal shows its exact Wave, deadline, minimum, required roles,
  accepted members, source sequences, reply hashes, seal digest and time; and
- supplemental evidence remains a separate audit fact with Agent/Device,
  Run/Turn, source Message/sequence, reply hash, evidence digest and submission
  time. It is never presented as accepted quorum content or Plan approval.

Untrusted names, reasons, identifiers and payload-derived strings render only
as text. Late Message content remains in the ordinary authorized Room timeline;
the audit card does not copy or reinterpret it.

## Interaction and Recovery

- All new controls have explicit accessible labels and keyboard operation.
- Simplified Chinese and English explain actor, exact pins and non-authority
  boundaries; light and dark themes remain readable.
- Selection, Team, Task, Plan revision, session or Discussion changes fence
  stale responses and confirmations.
- Stable operation IDs are reused only while the exact in-memory command is
  pending. After a response-loss reload, the browser first reads the Server
  candidate, Plan revision or delegation list; a confirmed absence may start a
  new command, while an unresolved read blocks mutation.
- At 1280, 720 and 390 pixel widths neither document nor new surface may
  overflow horizontally. Long digests wrap or use bounded local scrolling.

## Required Evidence

`WEB-065` may become `DONE` only when all of the following exist:

1. closed generated TypeScript/Go contracts and negative fixtures for the
   supersession control projection and exact activation template;
2. Server tests for Task/Room/Owner authorization, candidate/no-candidate,
   complete local carry pins, unsupported remote carry, all delegation states,
   stable ordering, corruption failure and zero-mutation reads;
3. Web tests for candidate creation, diff, exact human activation, delegation
   issue/revoke, permission hiding, stale/session/selection fencing and unknown-
   outcome authoritative reload;
4. composer/storage tests for default compatibility, advanced policy
   persistence/reset, quorum eligibility warnings and exact POST payload;
5. Discussion tests for policy, selection, seal and supplemental-evidence
   presentation without content/authority conflation;
6. a real Server-backed production Web browser acceptance at 1280, 720 and 390
   pixels covering both Plan control and quorum evidence, with empty browser
   warning/error logs and physical removal of its owned data; and
7. full contracts, Server, Web, workspace build, deterministic E2E, Bridge,
   docs and three private temporary-lifecycle rounds with zero new historical-
   prefix entries and physical removal of every owned run root.

## Non-Goals

This task does not add a graph editor, automatic replanning, a new carry rule,
automatic evidence selection, automatic Plan activation, new delegation scope,
new Discussion quorum semantics, automatic Run cancellation, live-model
quality claims, repository/Git authority, Remote Provider configuration,
GitHub/GitLab adapters, PR/webhook/push/merge flows, deployment or Release
acceptance. Optional Remote Evidence remains default-off and outside this
productization exit gate.
