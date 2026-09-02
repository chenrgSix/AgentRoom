# WEB-063 Plan Control Surface

Status: frozen implementation goal; completion evidence is appended only after
the Server, Web and production-browser acceptance passes.

## Goal

Add one Server-backed **Plan** surface to the canonical Task detail so an
authorized human can inspect, revise and review the exact execution proposal
before any graph is compiled. The browser presents Server facts and submits
closed commands; it does not infer approval, schedule nodes, dispatch Runs,
verify candidates or mutate a repository.

## Authoritative Read Model

The Server adds a bounded Task-scoped plan listing. It authorizes through the
Task's current Room and returns only plans whose durable `rootTaskId` equals the
requested Task. The Web surface must not enumerate a Room and silently discard
an incomplete page to discover Task plans.

For one selected plan the surface shows:

- plan state, current revision, digest, author and timestamps;
- Decision summary/items, exact source identities and required unresolved
  questions;
- every node's Agent, Task mode, repository identity, path scope, budget,
  inputs, outputs and required verification profiles;
- every dependency edge, gate and slot binding, plus external inputs and
  integration policy/targets;
- current compiled Task receipts when the exact revision is approved; and
- immutable approval/rejection history with reviewer, reason, reviewed
  revision/digest and root Task revisions.

Untrusted titles, summaries, paths, questions, reasons and identifiers render
as text. The UI exposes the complete gate/policy facts and labels all required
unresolved questions as approval blockers. It also explains that the Server
rechecks current sources, Agents, Tasks, repository inputs and competing plans
at mutation time rather than presenting their old browser projection as
authority.

## Revision and Diff

The current revision can be compared with the immediately preceding retained
revision. A deterministic structural diff reports added, removed and changed
JSON paths and renders bounded before/after values as text. Revision history is
read from the Server; no browser-generated version becomes evidence.

Only the Task Owner or Team Owner sees mutation controls. Editing starts from
the exact current definition and accepts closed JSON for the entire definition,
then submits a revision command binding:

- a stable operation ID;
- the selected plan ID;
- the exact current plan revision;
- the current root Task revision; and
- the complete proposed definition.

Malformed JSON, schema/domain-invalid definitions, stale revision/root pins,
changed operation replay, non-draft plans and lost authorization fail closed.
The successful Server projection replaces the editor and becomes the only
current version.

## Exact Human Review

Approval or rejection requires a non-empty reason. Approval additionally
requires an explicit confirmation that names the selected revision and a
shortened digest. The submitted command binds the full current digest,
revision, root Task revision, decision and stable operation ID. Selection
changes, a refreshed digest/revision or any stale response invalidate the local
confirmation and cannot update another plan.

The returned immutable receipt is shown with its operation, reviewer,
decision, revision, digest, root Task revision before/after and compiled Tasks.
Refresh reloads the receipt from approval history. If the response outcome is
unknown, the browser retains only the exact command pins and reason in
identity-scoped tab session storage, offers authoritative reload and exact
same-operation retry, and never invents success. Storage failure blocks a new
review command. No credential, plan definition, source bytes, local path or
repository content is retained in browser storage.

## Interaction and Layout Acceptance

- The Task tab list includes **Plan** and preserves the existing roving
  Arrow Left/Right, Home, End, Enter and Space behavior.
- Plan/revision selectors, editor, confirmation, review reason and retry
  controls have explicit accessible labels and keyboard operation.
- Simplified Chinese and English copy both describe exact approval and its
  limits; light and dark themes remain readable.
- At 1280, 720 and 390 pixel widths the document has no horizontal overflow.
  Node, edge, diff, receipt and editor content wraps or scrolls inside its own
  bounded container.

## Completion Evidence

Completion requires:

1. focused Server tests for exact Task scoping, Room authorization, pagination
   and no mutation from the read route;
2. focused Web tests for inspection, deterministic diff, editing, exact review,
   rejection, immutable history, response-loss recovery, stale/selection
   fencing, authorization, keyboard behavior and text-safe rendering;
3. Server and Web builds plus their full test suites;
4. a production Web build served against a disposable real Server fixture and
   browser inspection at 1280, 720 and 390 widths in both locales/themes; and
5. physical before/after confirmation that the isolated acceptance root and
   its SQLite data are removed.

Component tests or screenshots alone do not complete `WEB-063`. No live model,
Bridge Runtime, verification command or repository integration is claimed by
this Web milestone; that product chain belongs to `QA-052`.
