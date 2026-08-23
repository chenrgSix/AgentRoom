# QA-002 Two-Machine Managed Agent Acceptance

## Purpose

Prove that Alice uses the central Web service on machine A to wake Bob's
managed Codex through a released Bridge binary on machine B. A same-host,
container-only, Fake Runtime, or Generic Runtime run does not satisfy QA-002.

## Preconditions

- Machine A serves the current `main` Server and Web build behind HTTPS.
- Machine B can reach that HTTPS URL and has a working local Codex login.
- The v0.1.0 or newer Bridge archive matches machine B's OS and architecture.
- Alice records both host descriptions without publishing private addresses.
- The HTTPS certificate fingerprint is verified out of band before enrollment.

## Procedure

1. On machine A, migrate the acceptance database, start Server and Web, and
   confirm `/api/health/ready` returns `{"status":"ready"}`.
2. Alice creates a dedicated Team and Room named with the UTC test date.
3. On machine B, verify `SHA256SUMS`, start `agentroom-bridge console`, select
   Codex, set an explicit workspace, and enter machine A's HTTPS URL and
   verified certificate fingerprint.
4. Bob submits the join request. Alice enters the displayed one-time code in
   Web Agent management and approves the exact Device and Agent names.
5. Confirm Web shows Bob's Agent as ready and `/api/health` does not report an
   absent managed Bridge.
6. Alice sends `@Bob <unique acceptance nonce>: reply with this nonce only`.
7. Confirm the Run reaches `completed`, the Agent reply contains the nonce, and
   a single `traceId` reconstructs Message, Run, Delivery, and Run Event entries.
8. Stop machine B's Bridge, send a second nonce, confirm it remains queued,
   restart Bridge, and confirm exactly one reply appears.
9. Capture `/api/metrics` values for Bridge connections, queue depth, delivery
   retries, Run outcome, and event lag before removing any test data.

## Evidence Record

Create `docs/acceptance/evidence/qa-002-YYYYMMDD.md` containing:

```text
UTC start/end:
Server commit:
Machine A OS/architecture:
Machine B OS/architecture:
Bridge version/archive SHA-256:
Codex version:
HTTPS verification method:
Team/Room IDs:
Device/Agent IDs:
Online Run ID and trace ID:
Offline/reconnect Run ID and trace ID:
Observed state sequence:
Duplicate reply count:
Metrics snapshot with no credentials or private addresses:
Result: PASS or FAIL
```

Do not record access tokens, certificate private keys, prompts containing real
project data, user home paths, private IP addresses, or Codex credentials.
QA-002 becomes `DONE` only after a reviewed `PASS` record from two physical
machines is committed.
