# Contracts Module

- Prefix: `CON`
- Implementation: `packages/contracts/`
- Owns: cross-language wire schemas and compatibility policy

## Purpose

Contracts provide one versioned language-neutral definition for data exchanged
between the TypeScript central service, browser, Go Bridge, MCP clients, and
test fixtures. JSON Schema is authoritative; generated TypeScript and Go types
are build artifacts.

## Responsibilities

- Define shared scalar formats for IDs, UTC timestamps, versions, and cursors.
- Define Bridge envelopes, commands, events, acknowledgments, and errors.
- Define public HTTP payloads reused by Web and MCP adapters.
- Publish deterministic TypeScript and Go type generation.
- Maintain golden fixtures for valid, invalid, old, and forward-compatible data.
- Document protocol-version negotiation and compatibility windows.

## Exclusions

- Business authorization belongs to Security.
- State transitions belong to the owning domain module.
- Persistence schemas are not wire schemas and belong to DATA.
- Generated types must not contain hand-written business logic.

## Contract Layout

```text
packages/contracts/
  catalog.json
  schemas/
    common/
    bridge/
    room/
    run/
    registry/
  fixtures/
  generated/typescript/
  generated/go/
  scripts/
  src/
  test/
```

`CON-001` established the catalog and validator, `CON-002` added common schemas
and fixtures, and `CON-003` added Bridge messages. `CON-004` checks in generated
TypeScript and Go types, rejects generation drift, and runs the same fixture
suite through Ajv and the Go Draft 2020-12 validator.

## Common Envelope

```json
{
  "protocolVersion": "1.0",
  "messageId": "msg_...",
  "timestamp": "2026-08-22T10:00:00Z",
  "type": "run.requested",
  "payload": {}
}
```

IDs are opaque strings with a lowercase type prefix such as `team_`, `agent_`,
or `run_`; the suffix is base64url-compatible from its first character and
carries no business meaning. This includes leading `-` and `_` suffix characters
emitted by the Server's random base64url generator. Timestamps use RFC 3339 and
must be normalized to an uppercase `Z` UTC suffix. Protocol versions use
`major.minor` without a `v` prefix. Unknown message types are rejected by the
owning message schema. Unknown optional fields are ignored and preserved only
when the owning module explicitly supports round trips.

## Bridge Message Contract

`schemas/bridge/messages.schema.json` defines `bridge.hello`, heartbeat, Agent
publication/status, and the Run request, acceptance, status, output delta,
activity, reply, cancel, and handoff messages. Payloads carry immutable entity IDs, and
every Bridge Run event starts with sequence 1. `run.cancel_requested` is the
server-to-Bridge interrupt command required by the documented cancellation
flow.

`CON-011` adds `agent.provision.requested` and `agent.provision.result`. The
Server request carries one provision-request ID, target Device ID, existing
template Agent ID, Server-selected new Agent ID, bounded name and role, and a
transient six- or eight-digit management code. It carries no Runtime kind,
command, path, environment, Provider field, credential, tool, or permission
configuration. The Bridge result repeats the exact request, Device, template,
and proposed Agent identities and returns only `accepted` or `rejected` plus a
closed safe reason. A following authenticated `agent.publish`, not the result
alone, establishes the managed Agent as ready. `bridge.hello` optionally
advertises `supportsAgentProvisioning`; omission means unsupported so a rolling
upgrade never sends the new request to an older Bridge.

`CON-012` reserves the additive ADR-0021 Device pairing-session HTTP contract.
It defines opaque pairing/session/attempt IDs, closed session states, bounded
safe Device metadata, expiry, idempotency, verification-phrase projection, and
the claim, poll, approval, rejection, and cancellation payloads shared by the
TypeScript Server and Go Bridge. Secret values remain transport inputs and must
not appear in generated public state, logs, diagnostics, or fixtures except as
explicit negative-test seeds. Existing Bridge join and pair payloads remain
valid during rolling compatibility.

`CON-013` reserves the ADR-0022 Task work-model contracts. Closed schemas define
Task lifecycle and scheduling state, completion policy,
Task/definition/criteria revisions, canonical ordered criteria, human Owner,
closed Agent assignment roles, comparable budget units, attention and
next-action projections, Run attempt lineage, redacted Context Manifest, Result
submission/source/criterion/evidence records, and append-only review decisions.
Opaque IDs remain authority; Team display numbers are presentation only. Old
Task states and absent manifests remain valid only in the documented migration
window, and no compatibility mapping may remove `outcome_unknown` or make
`run.taskId` optional.

Member HTTP, manual-Agent MCP, and managed-Agent Device proposals use distinct
authentication envelopes but one Result semantic contract and idempotency
identity. Fixtures reject actor/Run mismatch, unknown evidence kinds, local
paths, copied evidence payloads, stale IDs masquerading as current revisions,
and review or completion authority in an Agent transport request.

`WSP-001` adds optional opaque `workspaceRef` and `workspaceGeneration` fields
to managed Agent publication plus `supportsWorkspaceLeases`. They are path-free
comparison identities, not Runtime scope IDs or permission grants. Older
Bridges omit them and remain limited to reference-only Artifact evidence.

`REG-005` adds optional `runtimePolicy` to managed Agent publication. The
closed summary contains exactly one `filesystemAccess` enum with
`read-only`, `workspace-write`, or `local-policy`; local paths, commands,
environment variables, Provider data, credentials, and arbitrary extension
fields are invalid. Older Bridges may omit the field and remain compatible.

`run.output_delta` is a Bridge-to-server preview event. It carries one bounded
text addition and an optional `reset` flag within the same strict Run event
sequence used by status and reply events. A reset replaces the provisional
browser projection before applying its content; it does not delete persisted
Run evidence. Output deltas never append Room Messages, never carry Discussion
assessment data, and never count as a completed Agent turn. `run.reply` remains
the sole authoritative visible reply and seals or replaces any provisional
projection. Servers accept Bridges that never emit output deltas; deployment
must upgrade the central service before enabling a Bridge that emits the new
message type.

`run.activity` is a recoverable, sequenced view of explicitly public Runtime
work. It carries a stable activity ID, `reasoning` or `tool` kind, lifecycle
phase, and bounded optional label/content. Reasoning content means a Runtime's
official summary stream, never hidden chain-of-thought. Tool activity exposes
only an allowlisted display name and phase; structured command records,
arguments, tool input/output, and approvals are outside the wire contract. Activity
never appends a Room Message or counts as an Agent reply.

`run.reply` has an additive optional `assessment` object for Discussion
evidence: goal satisfaction, confidence, question/evidence deltas,
disagreement, Reviewer approval, and a recommendation. Clients that omit the
field remain fully compatible and are evaluated as reply-only participants.

Every `run.requested` carries a stable `deliveryAttemptId` and
`idempotencyKey`, plus the central `traceId`. Task-capable requests add the
authoritative `taskId`, a logical Session request with Task scope and resume
policy, and an inclusive Room `contextCursor`; projected context Messages carry
their Room sequence. Retries preserve these fields so the Bridge can compare
the persisted payload hash and acknowledge without starting a second Runtime.
Every Bridge-to-server Run event must echo the same non-empty `traceId`; the
server rejects an absent, invalid, or mismatched value. Local inbox data written
before trace propagation is not a recoverable protocol 1.0 record and is
handled by the Bridge's incompatible-record policy rather than inferred by the
server.

Task-capable requests may carry a `contextPlan` with independently revisioned
Room and Task memory projections. Each projection is bounded, includes the
authoritative source Room cursor and a unique list of source Message IDs, and
contains no provider-native state. A full bootstrap carries both projections;
a resumed Bridge may retain only the projection whose revision is newer. An
empty plan is invalid, and omission remains compatible with older peers.
The same plan may include a revisioned non-empty `resultEvidence` page with at
most 20 ArtifactRefs. Additive `deliveryKind`, `fromRevision`,
`throughRevision`, and `hasMore` fields distinguish a newest-first bootstrap
window from a strict ascending continuation page; every new reference also has
a Task-local `artifactRevision`. References identify commit, branch, relative
file/patch, test-result, or document evidence and retain creator plus optional
source Run. A reference may also carry at most 20 immutable lineage references,
each with a relation ID, the closed `derives_from`/`reviews`/`verifies` type,
and one opaque target Artifact ID. The target need not be duplicated into the
same bounded page. A content-bearing Patch, Markdown document, or JSON test result adds
one closed descriptor with content ID, bounded size, exact media type and
SHA-256, plus an `artifact://` logical alias. It never embeds file bytes, a
local path, tool output, provider session, or permission grant.

Managed Agent capabilities may independently advertise Artifact publication
and isolated materialization. Publication requires the existing Workspace lease
capability; neither optional flag grants access by itself. After isolated bytes
are verified, `run.accepted` may carry at most 20 closed materialization
receipts. Each repeats the pinned Artifact/content IDs, size, digest, logical
alias, and only the bounded `verified` or `reused` state; additional local or
provider-native fields are contract-invalid. A pre-Runtime deterministic
verification failure instead carries one closed, non-retryable
`artifactMaterializationError` and no receipt. This negative acknowledgement is
the sequence 1 delivery cut that permits the following sequence 2 `failed` or
`canceled` event; retryable download failures send neither form and remain
pending for exact redelivery.

An optional `longTermMemory` plan carries independently revisioned Room and
Task snapshots. Each scope contains at most 24 typed entries, an
`activeComplete` flag, immutable content, lifecycle state, optional
supersession link, and bounded arrays of Message, Artifact, Run, and Discussion
source IDs. At least one source ID is mandatory. These entries are quoted
provenance claims; they neither grant access nor replace the referenced central
records.

Coverage-capable requests add a `roomContextBundle` that is independent of any
Bridge-local native Session. It names one immutable rolling checkpoint, the
complete bounded raw interval after that checkpoint and before the trigger, and
the target trigger sequence whose content remains the separate current request.
The envelope includes exact counts and UTF-8 byte sizes; gaps, overlaps, future
checkpoints, oversized tails, and provider-native state are invalid.

A Bridge reports a `roomContextConsumption` only after selecting a local
started/resumed/recreated Session, validating the complete interval, and
reaching the Adapter-specific durable prompt-acceptance point. The receipt names
the previous local cursor, optional checkpoint actually used, accepted raw
interval, final coverage cursor, and acceptance disposition. A Server bundle
never claims to know the previous local cursor.

A Bridge may add a logical Session status to `run.status`: only `started`,
`resumed`, or `recreated`, the consumed context cursor, an opaque hashed Runtime
scope ID, and its exact consumed result-evidence revision may cross the
boundary. The same scope ID is optionally published with the managed Agent and
included in the Run request. Provider-native session IDs, local workspace
paths, and local session-store keys are forbidden inside these closed objects.
All Task Session and Room coverage fields are additive during the rolling transition; their
absence retains the legacy Room-scoped behavior without allowing a Task-scoped
binding to reuse a legacy native session.

An `input_required` status may add one closed `clarification` object containing
only `kind: task`, a bounded question, and optional bounded answer choices. It
cannot carry an approval kind, command, path, tool input, capability grant, or
provider request ID. The object asks for missing Task-domain information; it
is not a transport for Runtime permission approval. A clarification object on
any other status is contract-invalid.

The request may also include the target Agent name, named context senders, and
the exact enabled Room peers eligible for reply routing. These are display and
prompt-projection fields; stable IDs and server-side eligibility remain routing
authority.

## Versioning Rules

- Additive optional fields are backward compatible within a major version.
- Removing, renaming, or changing meaning requires a new major version.
- A Bridge declares its supported version range during `bridge.hello`.
- The server selects one mutually supported version or closes with a structured
  incompatibility error.
- Rolling upgrades must tolerate one previous minor version.
- Compatibility behavior requires fixtures and release notes.

The required Run-event `traceId` is an explicitly approved pre-stable contract
reset after `v0.2.0-rc.1`; that prerelease is not inside the rolling-upgrade
window and must be replaced rather than mixed with the strict server. The next
release establishes the protocol 1.0 compatibility baseline. After that
baseline, the major-version and rolling-upgrade rules above apply without this
exception.

## Error Envelope

Errors contain stable `code`, safe `message`, optional `details`, and
`retryable`. Messages never contain credentials, raw local paths, stack
traces, or internal database errors.

## Verification

- Validate every golden fixture against JSON Schema.
- Generate TypeScript and Go types twice and require no diff.
- Round-trip fixtures through both language validators.
- Reject malformed IDs, timestamps, envelopes, and incompatible versions.
- Fuzz Bridge envelope decoding at the trust boundary.

## Task Mapping

`CON-001` through `CON-010`, plus cross-language portions of `QA-001`.

## Dependencies

None. Every other module consumes these contracts.
