# QA-020 Artifact-to-Artifact Recovery Acceptance

## Result

- Date: 2026-08-26
- Result: **PASS**
- Scope: deterministic local real-Server and two-Bridge recovery

This acceptance closes the deterministic P17 gate for verified Artifact
content handoff. It does not claim two physical machines, a production
deployment, release admission, or a credentialed provider Runtime.

## Topology and Product Loop

`artifact-to-artifact-recovery.test.ts` starts one real Fastify Server and two
separately paired Go Bridge processes. Each Bridge has a distinct Device
credential, `dataDir`, configured Workspace, managed Agent, and Runtime process.
A faulting HTTP/WebSocket proxy forwards ordinary traffic without replacing any
Server or Bridge implementation.

Bridge A publishes a content-bearing canonical Artifact A from an active Run.
Bridge B receives A through a later Run's pinned result evidence, installs it
outside its configured Workspace, and exposes only the verified logical alias
to its Runtime. The Runtime reads the installed file, checks the expected
SHA-256, writes a derived JSON result in its locally authorized output
directory, and Bridge B publishes canonical Artifact B with an immutable
`verifies` relation to A.

The final Task has revision 2 and exactly two Artifacts. Both explicit exact
publication retries return their original Artifact identities and create no
extra revision.

## Recovery Matrix

| Cut | Injected evidence | Required convergence |
| --- | --- | --- |
| bind response loss | proxy consumes the first successful A bind response and closes the client socket | status lookup returns the already-bound A identity; exact retry returns the same identity |
| offline delivery | B is stopped before each consumer Message is submitted | both Runs remain queued and dispatch only after B reconnects |
| digest failure | proxy changes one byte in a length-preserving `206` range | B deletes the partial, emits deterministic `ARTIFACT_MATERIALIZATION_FAILED`, and never starts the Runtime |
| download restart | proxy holds the second range after the first 256 KiB partial is durable, then B is terminated | the same Run and `dataDir` resume at the durable offset and install exact A bytes |
| duplicate Run delivery | Server dispatches pending work after both hello and Agent publication | only one active handler executes for the Run; duplicate delivery cannot race the preparing transition |
| terminal replay | the prior digest-failed Run remains in the durable inbox when B reconnects | the negative acknowledgement and terminal event replay without downloading the failed Artifact again |
| derived publication retry | B publishes the same bytes and `verifies` relation twice | both calls return Artifact B, Task revision remains 2, and one immutable B-to-A relation exists |

The installed source is byte-for-byte equal to A, has mode `0400`, and resides
under Bridge-owned `materializations`, not the configured Workspace. The
Runtime deliberately writes its local staging path to stdout; the Room reply
contains only `artifact://.../source.patch`, proving path replacement at the
Bridge boundary.

## Defects Closed by This Gate

The first recovery run exposed two independent Bridge defects rather than
weakening the acceptance:

- duplicate `run.requested` frames for one active Run were both starting
  handlers, allowing concurrent preparation against one durable inbox record;
- a persisted terminal materialization failure was re-downloaded during
  reconnect recovery instead of replaying its established negative outcome.

Focused Connection and Delivery regressions now preserve active-Run
single-handler execution and forbid re-preparation of the deterministic
materialization-failure terminal state.

## Verification

- `go test ./internal/connection ./internal/delivery` passes the focused
  recovery regressions.
- `npx tsx --test tests/e2e/artifact-to-artifact-recovery.test.ts` passes the
  real-Server/two-Bridge recovery scenario.
- `npm test` passes 127 Server, 24 Web, and 4 contract tests plus generated Go
  contract coverage and strict type checks.
- `go test ./...` passes every ordinary Bridge package. `go vet ./...` and
  race-detector tests for Connection, Delivery, and Runtime pass.
- `npm run test:e2e` passes the new two-Bridge recovery scenario, the guarded
  three-Agent MCP handoff, and the paired real Go Bridge/Pi protocol scenario;
  the credentialed Codex/Pi scenario is explicitly skipped as designed.
- `npm run build`, `npm run validate`, and `npm run lint:docs` pass with current
  generated contracts, 7 schemas, 56 fixtures, and 58 maintained Markdown
  files.

## Remaining Physical Gate

This test uses separate real processes and isolated local persistence but one
host. A physical two-machine repetition remains an explicit extension of
`QA-002`; network/firewall, host trust, packaging, and operational deployment
evidence are not inferred from this deterministic gate.
