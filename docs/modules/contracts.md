# Contracts Module

[ADR-0036](../adr/0036-add-governed-software-team-execution.md) introduces closed
decision/plan contracts and later capability-negotiated execution/input/grant/
repository/verifier envelopes. JSON Schema remains the wire authority with
generated TypeScript and Go. Structural validity does not prove graph topology,
referential integrity, authorization, local capability or evidence truth.
Old Bridge compatibility never allows silent downgrade of governed coding.

[ADR-0028](../adr/0028-preserve-continuous-web-work.md) adds optional bounded
`search` to Workbench queries. It matches authorized Task titles or exact Team
display numbers and binds pagination to normalized search. Existing callers
remain valid; JSON Schema and generated TypeScript/Go fixtures are authoritative.

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
    work/
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
emitted by the Server's random base64url generator. Timestamps use the common
Go/JavaScript RFC 3339 subset: uppercase `T` and `Z`, seconds `00` through `59`,
and optional fractional seconds of one through nine digits. Protocol versions use
`major.minor` without a `v` prefix. Unknown message types and envelope fields
are rejected. Payload extensions remain valid only where that payload schema
deliberately declares an extension point; a generic top-level property is not
rolling-compatibility authority.

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

`CON-015` closes the Bridge build-version identity gap. New Bridges normalize
their build version to semantic form without a leading `v` before
`bridge.hello`; the Server validates and persists that authenticated current
version independently of the immutable version recorded by the original
pairing session. The hello schema temporarily accepts the already released
`v`-prefixed form for rolling compatibility, but the Server canonicalizes it
before persistence. Heartbeats do not carry or overwrite build identity, and an
in-place upgrade advances the observation only with a newer connection epoch.
This separation lets physical evidence prove both the original pairing and the
currently installed package without requiring a new Device or credential.

`CON-017` makes that JSON Schema executable at both Runtime boundaries. Before
materializing JSON, generated TypeScript and Go admission gates enforce depth
64, 8,192 value nodes, 4,096 numbers, a 256-character numeric token and an
absolute exponent bound of 512. Frames are text-only strict UTF-8, and the same
raw lexical gate rejects lone, reversed or mismatched Unicode surrogate escapes
before either runtime can replace or retain a language-specific value. The
generator then applies a deterministic Ajv
standalone validator for TypeScript and a dereferenced embedded schema plus one
startup-compiled validator for Go. The Server decodes each raw Bridge frame
before any type-specific business parse; the Bridge does the same for each raw
Central frame before its first business unmarshal. Invalid frames produce only
a stable rejection and never echo the payload or validator diagnostics.

Generated per-message metadata names every canonical property and declared
integer/number path. It rejects ASCII or Unicode case-fold aliases before Go's
`encoding/json` can bind them, normalizes mathematical integer spellings such
as `1e0`, and gives every declared integer an explicit JavaScript-safe bound.
Declared numbers must also be finite and may not underflow from a nonzero exact
decimal to zero. Open extension numbers whose exact value survives a
JavaScript JSON round trip remain ordinary numbers; unsafe or non-finite values
remain opaque raw JSON values so re-serialization does not silently change
them. The limits are cross-language Runtime admission rules in addition to the
authoritative schema and deliberately reject over-budget open extensions.

The protocol 1.0 envelope now requires its message ID and timestamp and is
closed to unknown top-level fields. `run.reply` is bounded to the Server's
20,000-Unicode-code-point persistence limit. All hand-written Server string
bounds use the same code-point semantics as JSON Schema, including astral
characters, clarification, activity, assessment, output and Error text. Error
code shape/length and its 512-code-point message limit agree across schema and
Server invariants; canonical timestamp negatives also prove every schema-valid
timestamp can be decoded by the generated Go `time.Time` fields. Unknown
Error fields are closed while `details` remains the explicit service-allowlisted
extension point. Its currently interpreted `exitCode` and `stderrCaptured`
fields are declared so their types are normalized before business use;
`category` remains a bounded string for forward compatibility and the Server
maps unknown categories to `unknown`. Golden fixtures prove those negatives in
both languages and retain the intentionally open payloads used by already
released 1.0 clients.
The declared `agent.status` frame is consumed after hello with exact Device,
connection-epoch and owned-Agent checks; it no longer falls through as a
hello-required error. Agent publication name and role both use the durable
80-code-point domain bound (including astral text) across schema, Server,
Bridge configuration and SQLite.
The derived structured-Mention display snapshot remains within its historical
160-code-point storage bound by truncating only the display label; immutable
`agentId` routing and the full Registry name/role are unchanged.

`CON-012` defines the additive ADR-0021 Device pairing-session HTTP contract.
It defines opaque pairing/session/attempt IDs, closed session states, bounded
safe Device metadata, expiry, idempotency, verification-phrase projection, and
the claim, poll, approval, rejection, and cancellation payloads shared by the
TypeScript Server and Go Bridge. The Owner client supplies the create-time claim
secret, and the Bridge supplies the poll secret; generated public projections
never echo either. Synthetic secrets appear only in request fixtures or explicit
negative projection tests and never in generated public state, logs, or
diagnostics. Existing Bridge join and pair payloads remain valid during rolling
compatibility.

`CON-014` implements the ADR-0023 wire extension. It adds a closed
`DevicePairingTrustDescriptor` only when an installation explicitly uses
`private_scoped_ca`:

```text
mode: private_scoped_ca
origin: exact HTTPS origin
installationId: stable non-secret installation identity
trustEpoch: monotonic positive integer
caCertificateSha256: 64 lowercase hex characters over canonical DER
```

Public-CA pairing omits the descriptor; omission never means private trust on
first use. The authenticated Owner pairing projection may carry the descriptor,
and Web may place the exact object in the locally generated pairing-link
fragment. After local TLS bootstrap, the Device claim echoes the exact public
descriptor but never the public certificate; the Server compares it with the
installation projection. The transcript used for the verification phrase binds
the complete descriptor so origin/install/epoch/digest substitution cannot
silently join the intended session.

The same work defines the bounded well-known CA response and authenticated
rotation offer. The well-known response contains exactly one PEM CA certificate
whose canonical DER matches the descriptor and no credential or private key. A
rotation offer binds the exact Device, origin, installation ID, strictly newer
epoch, next CA certificate/digest and overlap deadline; at most current plus
next trust may be active. JSON Schema closes shape and scalar constraints, while
Security and Bridge enforce persisted origin, Device, monotonicity, CA
properties, digest, TLS and overlap semantics.

Fixtures reject unknown trust modes, HTTP origins, userinfo, origin paths or
fragments, zero/downgraded epochs, malformed digests, extra certificates,
credentials, CA private keys, redirect metadata and a private-scoped session
projected to an unsupported legacy Bridge. Generated TypeScript and Go types
remain additive within the pairing protocol compatibility window.

The implementation validates 116 shared fixtures and deterministically
generates TypeScript and Go definitions for the trust descriptor, Owner/session
projection additions, claim echo, capability bit, next-CA offer and
acknowledgement. Cross-record epoch ordering, certificate parsing and
installation/Device authorization remain owning-service checks rather than
claims JSON Schema can prove alone.

`CON-013` implements the ADR-0022 Task work-model wire contracts in
`schemas/work/task-result.schema.json`. Closed schemas define
Task lifecycle and scheduling state, completion policy,
Task/definition/criteria revisions, canonical ordered criteria, human Owner,
closed Agent assignment roles, comparable budget units, attention and
next-action projections, Run attempt lineage, redacted Context Manifest, Result
submission/source/criterion/evidence records, and append-only review decisions.
The Workbench query additionally closes Owner, Room, priority, assigned Agent,
and UTC update-bound filters while preserving bounded cursor pages.
Opaque IDs remain authority; Team display numbers are presentation only. Old
Task states and absent manifests remain valid only in the documented migration
window, and no compatibility mapping may remove `outcome_unknown` or make
`run.taskId` optional.

Member HTTP and the manual/managed Agent transports share one Result semantic
contract and idempotency identity. Agent envelopes name the closed actor kind,
Agent and Run; the owning service must bind all three to authenticated state and
the current assignment before accepting the proposal. Fixtures reject unknown
evidence kinds, local paths, credential material, assignment audit authority,
unbounded Workbench pages, and review or completion authority in Result review
input. Cross-record actor/Run/source membership remains an owning-service
authorization check because JSON Schema cannot query central persistence.

`run.requested` optionally carries the same `contextManifest` definition so an
older Bridge may ignore the additive field during rolling compatibility. Every
new managed Delivery produced by the current Server includes it. Generated Go
and TypeScript types expose the closed manifest shape, and the Bridge projects
its frozen goal, criteria, permission summary and omission list without gaining
Server authority over local Runtime policy.

`WSP-001` adds optional opaque `workspaceRef` and `workspaceGeneration` fields
to managed Agent publication plus `supportsWorkspaceLeases`. They are path-free
comparison identities, not Runtime scope IDs or permission grants. Older
Bridges omit them and remain limited to reference-only Artifact evidence.

`WSP-002` adds optional `workspaceAlias` to the same managed Agent publication.
It is a trimmed, path-separator-free display label of at most 80 characters and
requires no authority interpretation. The schema explicitly rejects known
local-binding keys such as Workspace path/root, command, environment, and
filesystem/network policy while retaining additive unknown-field compatibility.
The Server repeats those negative checks and rejects invalid aliases; an older
Bridge may omit the alias without changing Device or Agent identity.

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

`CON-001` through `CON-014`, plus cross-language portions of `QA-001`.

## Dependencies

None. Every other module consumes these contracts.

## Client owner entry contracts

ADR-0035 adds optional member binding, initial Room selection and an independent client-access proof to Device pairing, plus bounded client entry request/projection payloads. New member-aware links require an updated client; old links retain Device-only behavior. JSON Schema remains the cross-language authority and generated types must agree in Go and TypeScript.
