# WEB-065 Bounded-Autonomy Product Surface

Status: accepted on 2026-09-03. The goal was frozen before implementation on
the same date, and `docs/TASKS.md` remains the sole delivery-state register.
This task productizes already accepted `EXEC-005`, `DISC-011` and `DISC-012`
authority; it adds no execution, evidence, repository or Discussion semantics.

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

## Accepted Delivery

The canonical Task **Plan** tab now reads one closed Server projection for the
current Plan, its immutable next-revision candidate, the complete mandatory
local carry set and every retained delegation state. An authorized human can
prepare and inspect a structural revision diff, explicitly activate the exact
candidate, or issue and revoke one bounded Tech Lead delegation. The browser
does not calculate carry eligibility or reuse digests, cannot activate as an
Agent and never obtains repository authority.

The Plan surface binds every command to the current Plan revision/digest,
control revision and root Task revision. Candidate activation uses the
unchanged Server-prepared carry selections. Delegation issue binds the selected
primary Agent, expiry and reason; revocation binds the exact retained revision
and digest. A transport-unknown mutation locks every new command and editable
field until an authoritative reload succeeds. Successful activation reloads
the parent Plan before exposing another action, and local datetime input is
converted to an actual future instant instead of being shifted by the browser
timezone.

The Room composer keeps ordinary multi-Agent Discussion defaults unchanged and
adds one explicit advanced policy surface. A participant may select all
eligible or question-focused selection and may opt into read-only quorum with
minimum completion and soft-deadline values. Saved draft state is scoped to the
same Room and Task, and sending or clearing resets the advanced fields. The UI
warns from its current projection when a selected Agent does not appear to have
the required managed, Device-backed, read-only and supplemental-evidence
capabilities; Central remains the sole admission authority.

Expanded Discussion details render the retained policy, immutable per-Wave
selection snapshot, exact quorum seal and content-free supplemental evidence.
Accepted member/source-sequence/reply-hash facts remain visibly separate from
late evidence Agent/Device/Run/Turn/message/digest facts. The audit card neither
copies late Message content nor treats it as accepted quorum content, Plan
approval or scheduler authority.

The implementation was retained in the independently reviewable commits
`2f03d96`, `3c30cdf`, `c70e594`, `a606e5e`, `576a42a`, `4774803` and
`a5f8fc7`. The last commit removes a generated-enum-name dependency from one Go
authority fixture; it does not change production behavior.

## Production Browser Evidence

The production Web build was exercised in the in-app browser against a real,
disposable trusted-Team Server and its SQLite-backed product fixture. Recovery
used the fixture's temporary Owner authority. No browser state was substituted
for a Server fact.

On the Plan tab, the browser read current revision 2, issued a one-hour
delegation to an actual primary Agent, observed it as active, revoked the exact
retained record and observed the revoked state. It then prepared revision 3
from the complete current definition, displayed the title and new-to-existing
Task-pin structural diff, showed that this fixture required no prior evidence
carry, activated the exact candidate and reloaded authoritative revision 3.
The revoked delegation remained revoked.

On the Discussion surface, the browser selected the real three-Agent fixture
and displayed question-focused selection, read-only quorum 2 at the 30-second
soft deadline, the frozen selection digest, a seal with two accepted reply
hashes/source sequences and one separately retained late supplemental-evidence
record without Message content. The composer selected two eligible managed
Agents and exposed the exact focused/quorum inputs and capability summaries.

At 1280, 720 and 390 pixel widths, both the Plan and Discussion pages reported
document scroll width equal to viewport width, with no horizontal overflow.
Browser warning/error logs were empty. Shutdown printed and physical inspection
confirmed removal of `/private/tmp/convene-wire-test-run-MLpXmJ`.

## Verification Record

The final full gates passed on 2026-09-03:

- contracts: 101/101 checks, 14 schemas and 258 fixtures, generated sources
  current, strict TypeScript and Go round trips;
- Server: 594/594 tests;
- Web: 277/277 tests and the production build;
- product experience: 2/2 local and trusted-team Server-backed fixtures;
- Bridge: every Go package under `go test ./...`;
- deterministic E2E: 9 passed and the explicitly live-provider-only case was
  skipped;
- Bridge UI, sanitized QA evidence and product-site acceptance all passed; and
- workspace schema validation and the complete workspace build passed.

Every suite-created run root reported cleanup and was physically absent after
completion, including the Server root
`/private/tmp/convene-wire-test-run-WXEbQ9`, Web root
`/private/tmp/convene-wire-test-run-BggQLn`, Contracts root
`/private/tmp/convene-wire-test-run-GDh7rG`, Bridge root
`/private/tmp/convene-wire-test-run-O2dy6M`, product root
`/private/tmp/convene-wire-test-run-CAD8b0` and E2E root
`/private/tmp/convene-wire-test-run-XrW8jr`.

The lifecycle gate then ran `npm run test:temp-lifecycle` three consecutive
times under one owned, isolated directory. Each round passed 25/25 success,
assertion-failure, spawn-failure, timeout, cancellation/signal, orphan-process,
nested-run and parallel-owner cases. Before and after all three rounds, the
isolated parent contained zero `agentroom-*`, `agent-room-*`, `convenewire-*`
or `convene-wire-*` entries. Each nested run root and the outer root
`/private/tmp/convene-wire-test-run-96gQWT` were physically removed. No global
temporary-directory glob was scanned or deleted.

This acceptance does not claim live-model quality, multiple physical machines,
a packaged Release, automatic replanning, repository/Git authority or a new
Remote Provider capability. It completes only the human-facing product closure
for already accepted bounded-autonomy Core authority.
