# ADR-0030: Acknowledge macOS desktop activation before Console startup

- Status: Accepted
- Date: 2026-08-31
- Supersedes: none
- Amends: ADR-0029

## Context

Wails beta.12 acquires the macOS desktop lock in `application.New`, but starts
its distributed-notification listener only during `Run`. A second launch can
exit successfully after sending a notification that no listener received.
Moving Console construction behind `New` does not close that gap. The owner
has requested the repair rather than leaving BRG-057 deferred.

## Decision

### Acknowledged, user-local activation

On macOS, acquire a stable desktop lease and open a Unix-domain listener before
constructing Wails or the Console. Disable Wails single-instance handling only
on macOS; Windows and other supported platform paths remain separate.
Secondaries forward one bounded, validated activation and require an explicit
acknowledgement. An acknowledgement means the receiver accepted the in-memory
UI intent, not that pairing or a Runtime operation completed. It never starts
a second Console or worker. Connection establishment may wait for a bounded
startup interval; after sending, an absent acknowledgement is uncertain and
must not cause automatic resend or fallback execution.

Use the OS-provided `NSTemporaryDirectory()` rather than an environment-selected
directory to derive short private rendezvous paths. Validate ownership, type
and permissions, reject symlinks and overlong Unix socket paths, and verify
the peer's effective user with Darwin local peer credentials on both ends.
The sender checks peer identity before sending any pairing proof. Only the
lease owner can remove a verified stale socket; the stable lock inode is never
unlinked. Bound frame length, concurrent connections and read/write lifetime.
Shutdown closes the receiver and outstanding connections before releasing the
lease. No HTTP port, installed service, provider call, secret file or central
protocol is added. The Console remains the only Bridge lifecycle owner.

### UI intent and URL delivery

Keep a validated pending pairing intent until the main-thread UI dispatcher is
ready. Wakes may coalesce but cannot erase a pending pairing link. A distinct
pairing link cannot silently replace a previously acknowledged pending link;
reject it until the pending intent has been dispatched. Admit an explicit
first-launch pairing link into the same queue before publishing the receiver,
instead of independently embedding it in the initial WebView URL. A link-free
background launch does not enqueue a wake. Call native UI code outside the
intent mutex. Closing the receiver rejects new intents and clears pending
in-memory proof.

For a secondary macOS process with no explicit URL argument, use a bounded
native AppleEvent capture before forwarding; bypassing Wails must not turn a
LaunchServices URL into an ordinary wake. The primary retains the existing
Wails application URL event handler. Capture and forwarding errors contain no
URL, claim proof or local path.

### Older executables

Respect the released Wails lock as a compatibility guard. An older primary
with no acknowledged transport must produce an explicit bounded failure asking
the owner to close it, not a fire-and-forget fallback. New executables also use
their own stable lease to avoid inheriting old Wails' unlink-after-unlock inode
race. Old senders do not gain reliable forwarding retroactively. The existing
Console data lock remains the final worker-ownership boundary during mixed-
version operation; no claim of a new protocol handshake with an old binary is
made.

## Verification

Use real macOS subprocesses and Unix socket/flock/peer-credential APIs with
unique temporary identities and fake Console dependencies. Exercise delayed
listener and UI readiness, duplicate/wake coalescing, distinct pairing conflict,
lost acknowledgement without resend, shutdown, crash/stale-socket recovery,
exclusive data ownership, malformed/slow frames, symlinks, foreign identity and
secret-free files/errors. Verify the native AppleEvent capture separately.
Run desktop tests, race, vet and native build plus relevant Bridge regression
gates and Windows compatibility compilation. Packaged LaunchServices, physical
Windows and Release evidence remain distinct from these local native checks.

Delivery state lives only in TASKS; this decision replaces the macOS deferral
in ADR-0029 without expanding into Console decomposition.
