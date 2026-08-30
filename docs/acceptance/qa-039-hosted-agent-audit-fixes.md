# QA-039 Central Hosted Agent audit fixes

## Goal

Close the post-implementation Central Hosted Agent audit without expanding the
authority accepted by ADR-0026. The repair remains inside the existing Central
Server, Web, SQLite and deterministic fake-provider test surfaces. It does not
change the Bridge protocol or packages, add a deployment service, grant local
computer authority, or require a production provider credential.

## Required closure

- Room removal is authoritative before any Hosted prompt crosses the HTTPS
  dispatch fence.
- Streaming redaction is safe when one sensitive value spans provider deltas.
- Local-to-trusted-team adoption cannot continue using a database-contained
  Hosted wrapping root.
- Profile revision and active-work fences remain authoritative across provider
  probes, and probes have bounded time and concurrency.
- The adapter accepts the supported Responses queued-to-in-progress lifecycle
  while retaining strict event validation.
- Recovered expired Runs settle their durable invocation intent in the same
  process.
- Hosted Presence follows active Room membership, and local databases and
  backups receive restrictive filesystem permissions.
- Web configuration locking uses an explicit Server projection rather than
  inferring active work from Presence.

## Evidence status

Implementation and regression evidence are in progress. `QA-039` remains
`ACTIVE` until focused security/runtime/Web tests and the repository-wide gates
listed by `QA-038` pass against the final commit.
