# ADR-0035: Connect client owners to Team collaboration

- Status: Accepted
- Date: 2026-08-31
- Extends: ADR-0021, ADR-0027, ADR-0033, ADR-0034

## Context

Device pairing currently assigns the issuing Owner as the Device owner. A
colleague who receives that link has no separate human identity or browser
session. Treating the Device credential as human authentication would impersonate
the issuing administrator. Human and Agent Room rosters are independently
authoritative, but the normal onboarding experience should connect them.

## Decision

An optional member binding on a new pairing identifies an existing Team member
or names a new ordinary member, and explicitly selects initial Rooms. The pairing
issuer remains recorded separately from the actual Device owner. New identities
are created only in the approval transaction; retries cannot create duplicates.
Existing members are selected by immutable ID, never inferred from a name. An
Owner can bind their own identity or an ordinary member, never another Owner.
Device ownership, member binding and a separate human access grant are approved
together. One person can use multiple Devices with the same membership.

New member-aware pairing links advertise the extension. Updated clients generate
an independent human-access secret only for this flow. The Server stores its
hash, separately from the Device credential. Approval requires both this proof
and the ordinary pairing transcript. Legacy links and clients keep Device-only
behavior; omission must never silently grant human access. Existing Devices gain
no grants in migration. Their local owner deliberately re-pairs using the
existing recovery flow after Central confirms the actual member. Old Devices,
historical Runs and attribution are not silently reassigned or deleted.

New member-aware Devices publish new Agents only into the initial Rooms selected
at approval. New members join only those Rooms, rather than all existing Rooms.
Room settings preselect an Agent's human owner when the user adds that Agent;
the user can explicitly deselect that person. The submitted roster remains the
authority. Reads, republication and reconnect never restore removed people.
Legacy creation behavior remains compatible outside member-aware onboarding.

## Human entry and authority

The local authenticated Console offers Team and authorized Room entry. It uses
both the Device credential and a separately stored human-access key to request
a 60-second, single-use ticket. Only a hash is persisted. Tickets bind the exact
grant, Device, Team, member and optional Room, with all authority revalidated
when issued and consumed. They travel only in a URL fragment and are cleared
from browser history immediately. The browser requires an explicit entry action
on the identity confirmation screen, preventing silent account replacement.
This screen never asks for another administrator approval or copied login code.

Consumption establishes an independent Web session, scoped to this Team and
capped at ordinary-member authority even for an Owner's own client. It cannot
create Teams, issue durable credentials, recover accounts or acquire management
authority. Normal human Task actions still follow existing Task/Room rules.
Full administrator login remains an independent authentication path. Scoped
sessions never expose other Teams of the same User. Device revocation, Device
credential revocation, grant revocation, lost membership, changed ownership or
an archived Team invalidates entry and derived sessions. Room removal denies
access immediately without deleting human membership or historical content.

The key is stored in a distinct owner-only local file, omitted from Device
credential serialization, Runtime inputs, status, diagnostics and logs. Local
Console authentication and explicit clicks protect normal UI use; this does not
claim isolation from arbitrary malicious code running as the same OS user.
Private Bridge CA trust does not make a browser trust Central; ordinary browser
certificate requirements remain in force. No TLS bypass is introduced.

## Ownership, compatibility and verification

Contracts owns additive pairing and client-entry payloads. Security owns grants,
tickets, session scope and revocation; Registry owns Device/Agent attribution;
Team/Room owns participant persistence; Bridge owns local credentials and entry;
Web owns identity confirmation, navigation and default selection presentation.

Verify new/existing/self binding, duplicate approval, old-client refusal for the
new flow, legacy Device-only compatibility, separate secrets, replay/expiry,
cross-Team/Room/Device denial, Owner privilege capping, revocation during long
polls, restart, no default access to unrelated Rooms, explicit human removal,
local re-pair/cancel/switch isolation and browser identity switching. Run focused
and full tests, generated TypeScript/Go contracts, cross-process acceptance and
isolated browser checks. Production deployment, release publication and physical
Windows acceptance remain outside this change.
