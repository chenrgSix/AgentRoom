# ADR-0032: Separate Owner login recovery from the Hosted credential root

- Status: Accepted
- Date: 2026-08-31
- Supersedes: none

## Context

The deployment recovery file currently authenticates the installation Owner
and wraps Hosted credential data keys. Replacing that file to change a login
credential would break Hosted decryption. An Owner who still has a valid Web
session should not need the forgotten old login key to replace it.

## Decision

Add an installation-Owner-only recovery settings surface and same-Origin
authenticated GET/PUT `/api/auth/owner-recovery` routes. Team ownership alone
does not grant this authority. The browser generates a 256-bit random key,
shows it transiently and requires confirmation that it was saved before PUT.
The key travels only in the existing recovery-token header; PUT carries an
expected revision in its JSON body. No old key is required: a valid Owner
session is the explicit authority for this operation.

Migration 0056 stores only the SHA-256 verifier, monotonic revision and update
time in a singleton row. Absent a row, legacy deployment-file authentication
continues. Once a row exists, only its verifier authenticates Web recovery;
the deployment key is no longer an alternate remote login credential. The
deployment file remains unchanged and continues wrapping Hosted credentials.

The immediate transaction checks installation ownership, replaces the verifier
and revokes other Owner Web sessions while preserving the requesting session.
The same candidate and expected revision can be retried after response loss;
a competing change cannot be overwritten by a stale request. A retry never
revokes newly issued sessions again. Device, MCP, member and Hosted credentials
are unaffected. New material stays in memory only and clears on dialog close,
success, logout or component disposal; the saved private copy supports recovery
after a reload or a lost response. There is no automatic retry.

## Alternatives

Changing the deployment secret requires coordinated encryption-root rotation
and is not a login setting. Accepting the original file forever over HTTP would
leave a purportedly replaced credential usable. Plaintext database storage and
an unauthenticated reset endpoint are rejected.

## Compatibility and Security

This is additive Central/Web behavior, not a Bridge protocol change. Existing
installations keep their login until explicit replacement. Keep backing up the
deployment file for Hosted decryption; a database snapshot restores its own
login-verifier version. Old server binaries do not enforce the new verifier:
do not downgrade a rotated installation to pre-0056 behavior.

If both the saved key and all Owner sessions are lost, recovery requires the
server operator to stop Central, back up the database and deployment secrets,
remove the singleton override and revoke Owner Web sessions in one database
transaction before restarting. This deliberately restores the existing file
as login authority without changing Hosted encryption. It is not a remote API.

## Verification

Cover legacy migration, exact installation ownership, Origin and bearer denial,
invalid/stale input, transactional rollback, same-operation response-loss retry,
session scope, old-key denial, restart/backup persistence and unchanged Hosted
decryption. Web checks cover saved-key confirmation, safe copying, transient
storage, retry, conflict, late responses, keyboard access and narrow layouts.
