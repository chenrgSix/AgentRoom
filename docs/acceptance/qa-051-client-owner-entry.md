# QA-051 Client Owner Collaboration Entry

Recorded on 2026-08-31 against the implementation on
`codex/client-owner-entry`. The authoritative delivery states remain in
`docs/TASKS.md`; ADR-0035 owns the authorization model.

## Product behavior

An Owner can bind a Device to themselves, an existing ordinary member, or a
new member while selecting initial Rooms. A new person is created only when
the matching Device claim is approved. Approval atomically records the actual
Device owner, selected human participants and the independent client grant.
Another Device can reuse the same person without duplicating Team membership.

The client lists authorized Rooms and opens the Team or a selected Room. The
browser clears the fragment and asks the person to confirm the displayed
identity before replacing a current login. Cancellation leaves the existing
login and unconsumed ticket intact. The resulting session has ordinary-member
authority in exactly one Team, including when the person also owns that Team.

Room settings select an Agent's actual owner when adding the Agent. The human
checkbox remains independently editable. Saving Agent-only access persists
that explicit choice; removing an Agent does not remove the person, and Agent
publication or reconnect does not undo an explicit human removal.

## Authorization and compatibility evidence

Eleven Server scenarios cover new/existing/self bindings, atomic and
idempotent approval, selected-room boundaries, wrong-owner targets, separate
Device/human proofs, browser origin enforcement, ordinary-member authority,
cross-Team denial, durable credential and recovery denial, ticket expiry and
replay across restart, explicit human removal, and six revocation conditions.
An in-flight change request reauthenticates after grant revocation before
returning Room data. Deleting a session's grant lineage cannot promote it to
an unrestricted session because its independent required-grant marker remains.

The migration grants no human access to legacy Devices. Existing links remain
Device-only. Member links negotiate `memberAccess=1`; an old client missing
the independent proof, a downgraded approval, or an unsolicited grant is
rejected. Re-pairing is deliberate and retains historical Device attribution
and local Runtime/Workspace profiles.

Go tests prove separate owner-only proof persistence, identity matching,
symlink and broad-permission rejection on Unix, no proof in Device JSON or
Runtime inputs, authenticated local entry actions, exact-origin browser
dispatch, redirect rejection and stale pairing response rejection. Console
JavaScript receives only status and identity/Room projections, never a ticket
or human key. The secret is not a security boundary against malicious code
running as the same operating-system user.

## Verification

All commands below completed successfully. A task-specific writable Go cache
was used because the sandbox denies writes to the shared macOS Go cache.

| Check | Observed result |
| --- | --- |
| `npm test` | Server 363, Web 252, contract Node 14, embedded Bridge UI 56, QA evidence 45, product fixtures 2 and website 15 tests passed; strict TypeScript and shared Go contract tests also passed |
| `npm run test:e2e` | Seven deterministic cross-process scenarios passed; the explicitly opt-in live Codex/Pi scenario was skipped |
| `npm run build` | All implemented workspaces built successfully |
| `npm run validate` | Nine schemas and 145 fixtures validated; 12 fixtures were added for this change |
| Bridge `go test ./...` and `go vet ./...` | All implemented packages passed; the final Console regression was also rerun after its Runtime-input assertion was added |
| Bridge focused `go test -race` | Console, pairing and browser launch packages passed |
| macOS `go test -tags desktop ./cmd/convenewire-bridge-desktop` | Native shell compiled and desktop tests passed |
| Windows/amd64 desktop cross-build | `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -tags desktop` passed |
| `npm run lint:docs` and `git diff --check` | Maintained Markdown and changed-file whitespace checks passed |

The new deterministic E2E runs the real Go `pair-device` command and Console
against a real temporary Central over loopback HTTP. It validates the two
separate persisted proofs, actual-member ownership, authorized Room listing,
browser entry, human message submission, wrong-Room denial, replay denial and
revocation of the opened session. Only operating-system browser dispatch is
replaced by a capture helper; it does not execute a model or use a real account.

## Browser observations

The isolated preview used the production Web build, a real Go client and
temporary Central data. The in-app browser verified these visible behaviors:

- the client displayed the owner's name and only the selected Room;
- opening the Room showed the correct person, Team and destination before
  confirmation, with no remaining entry fragment;
- confirming entered that Room and a message appeared under the human's name;
- the account page displayed ordinary-member client entry and omitted Owner
  recovery management;
- full Owner login separately exposed self/existing/new-member pairing and
  explicit initial-room choices; and
- at a 390 px viewport, the pairing dialog fit within the viewport and the
  document had no horizontal overflow.

Screenshots contain synthetic fixture data only:

- [Client Room entry](assets/qa-051/client-room-entry.png)
- [Member confirmation](assets/qa-051/confirm-member.png)
- [Human Room message](assets/qa-051/member-room.png)
- [Scoped account controls](assets/qa-051/member-account.png)
- [Owner and initial Rooms](assets/qa-051/pairing-owner-and-rooms.png)
- [390 px pairing dialog](assets/qa-051/pairing-mobile.png)

The preview's Central and client were stopped, and its temporary database,
configuration and credentials were removed. No existing user Team, Device or
client configuration was modified.

## Limits

This is source-level product acceptance, not release or deployment approval.
No Release, published package, production migration, existing-client update or
physical Windows acceptance was performed. Native macOS linking reports the
existing SDK/minimum-target warnings; compilation on this Mac does not certify
older macOS versions. Vite reports the existing large-bundle warning.

Browser private-CA trust is still independent of Bridge-scoped trust. No TLS
warning was bypassed. Existing clients need an update and explicit owner-aware
re-pairing; the v0.4.2 packages do not yet contain this entry flow. The separate
live-runtime and two-machine release gates remain unchanged.
