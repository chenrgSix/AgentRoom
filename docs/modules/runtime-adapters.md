# Runtime Adapters

## Scope

- Prefix: `ADP`
- Planned locations: `bridge/internal/runtime/` and `apps/server/src/runtime/`
- Owns: local Runtime discovery/process/session lifecycle and the bounded
  Central-hosted model HTTP lifecycle

Runtime Adapters translate one stable Run request into a specific execution
backend. The adapter boundary isolates Codex and CLI lifecycle changes on a
Bridge, and supported remote-model HTTP changes inside Central, from Team and
Run state authority.

## Adapter Contract

Each adapter implements versioned operations for:

- discovery and capability reporting;
- starting or resuming a Runtime Session;
- streaming ordered status, output, and handoff events;
- interrupting and disposing a session;
- recovering observable state after Bridge restart.

Capabilities declare `invocationMode: managed | manual | hosted` plus support
for start, resume, streaming, interrupt, and handoff. Unsupported operations
must be hidden upstream rather than emulated silently. A `hosted` capability is
Central-owned and never published in a Bridge hello or Agent publication.

## Initial Implementations

`FakeAdapter` is deterministic and drives contracts, retries, races, and E2E
tests. The Codex native adapter is the preferred managed path, but targets a
pinned machine-readable schema/version and requires contract tests. A generic
CLI adapter is the L2 fallback with reduced lifecycle and resume guarantees.
Pull-only participants remain MCP clients and are not remote-wake capable.

The Generic CLI Adapter executes only the configured argument array in its
fixed workspace, sends the Run instruction on stdin, propagates only allowlisted
environment variables, and caps returned stdout at 20 KB. Exit failure,
deadline, cancellation, and output overflow become safe terminal Run events.
An executable start failure is distinct from a child process nonzero exit.
Codex and Generic nonzero exits include only a stable local classification,
numeric exit code, and stderr-presence flag. The central service applies the
same three-field allowlist before Run-event persistence; raw stderr and unknown
detail keys never cross that boundary.

Runtime discovery, readiness projection, draft preflight, configuration save,
and CLI enrollment share one platform-aware launcher check. On Windows a path
must identify a regular file with a case-insensitive `.exe`, `.com`, `.bat`, or
`.cmd` extension; Unix execute permission bits are not consulted there. On
Unix-like systems the path must identify a regular file with at least one
execute bit, independent of its filename extension. PATH discovery continues
to use `exec.LookPath`, while bounded known-directory discovery checks the same
four Windows launcher names without running them.

Pi uses a dedicated live parser over its non-interactive JSON event stream.
Preset version 5 owns only the
`--mode json` and `--print` transport flags plus the per-Run session selector;
tools, extensions, Skills, project context, and approval remain governed by the
owner's local Pi configuration and explicit local arguments. Bridge migration
removes the product-authored restrictions from preset version 2 while retaining
other owner-authored arguments from older configurations, and removes conflicting
owner session selectors before the Bridge adds a stable `--session-id` derived
from the logical Task Session binding. Pi assistant
`text_delta` events feed a bounded provisional preview. Explicit
`thinking_delta`/`reasoning_delta` summary text and tool execution name/phase
feed the separate activity stream; usage, structured command/tool records,
arguments/results, approvals, and provider protocol stay local. When a tool-using
assistant message is followed by a new assistant message, the next visible
delta resets the provisional preview so only the current answer remains. The
last completed non-tool assistant message is still the authoritative reply.
The local JSON event stream is capped at 512 KB and both the provisional output
and extracted reply remain capped at 20 KB. A trailing safety window prevents
partial credentials or the private `agentroom-assessment` envelope from
crossing a chunk boundary. Malformed JSON, a missing assistant reply, or
provider-specific raw tool-call markup fails the Run with
`RUNTIME_PROTOCOL_INVALID`; none of that raw stdout is published to the Room.
Normal managed Runs therefore append to one native Pi session per Task, Agent,
Runtime semantic configuration, and workspace across Bridge restarts. The
Bridge binding stores the native ID, consumed Room cursor, last Run ID, and
timestamps in its owner-only data directory. It stores workspace and semantic
configuration fingerprints rather than a raw workspace path. The session
receives a bounded local display name; Pi's
own session directory and provider configuration remain owner-controlled. The
explicit Runtime probe still adds `--no-session`, so diagnostics never pollute
normal history. Unscoped Codex probes likewise use an ephemeral Thread. The
central service cannot raise local Runtime permissions.

Codex preset version 5 uses the local Codex App Server over JSONL stdio. The
Bridge creates one persisted Thread per Task and Agent in the fixed
owner-selected workspace and Runtime semantic configuration, records only its
opaque Thread id under the owner-only Bridge data
directory, and calls `thread/resume` on later Runs. A missing or invalid stored
Thread is discarded and replaced once with a fresh persisted Thread. An
recognized `active writer` conflict from another local Codex client follows the
owner-selected `codexSessionConflictPolicy`. The default `preserve_and_retry`
returns retryable `CODEX_SESSION_IN_USE`, preserves the stored binding, and
never starts a replacement Thread. The explicit `start_new` policy keeps the
provider-owned old Thread intact, starts one fresh persisted Thread, replaces
the Bridge binding only after the new Thread is accepted, replays the full Task
bootstrap, and reports `recreated`; this trades native conversation continuity
for immediate progress. Any other resume rejection fails closed as retryable
`CODEX_SESSION_RESUME_FAILED` while preserving the binding; only an explicitly
recognized missing or invalid Thread or the configured active-writer policy can
trigger recreation. The conflict policy is local Agent configuration, is not
controlled by the central service, and does not broaden filesystem, tool,
network, or approval permissions. The Bridge
passes the owner-selected `read-only` or `workspace-write` sandbox,
and uses `approvalPolicy: never` so a remote Team message cannot escalate local
permissions. It publishes `item/agentMessage/delta`, resets provisional
output when Codex starts a new Agent message after a tool boundary, and treats
the last completed `agentMessage` plus `turn/completed` as authoritative. Tool,
reasoning-summary deltas and allowlisted tool item name/phase become activity;
raw hidden reasoning, structured command/tool records, arguments, and approval
protocol stay local. Interactive
server requests receive a protocol error instead of being approved. A bounded
safety tail, redaction, protocol/output limits, process-group cancellation, and
final-reply parsing match the Pi streaming boundary.

Generic CLI remains final-only by default because plain stdout has no stable
boundary between assistant text and private control output. An owner-authored
Generic configuration may explicitly select
`outputProtocol: agentroom-jsonl-v1`. Only that protocol publishes streaming
capability. Its newline-delimited `assistant.delta` events carry non-empty text
and an optional reset flag; exactly one `reply.final` carries the authoritative
assistant reply. It may explicitly publish `reasoning.delta`,
`reasoning.completed`, `tool.started`, and `tool.completed` activity. Unknown
JSON events remain private, while malformed JSON,
assistant events after the final reply, missing/duplicate final replies,
oversized output, or leaked provider tool markup fail closed. The complete
producer contract is maintained in `docs/generic-runtime-stream-contract.md`.

The first Fake Adapter lives in the central server workspace solely for the
in-process MVP acceptance harness. It implements the same ordered request/event
shape without claiming Runtime ownership; production adapters remain in the Go
Bridge once its interface is available.

## Central Hosted Model Adapter

[ADR-0026](../adr/0026-add-optional-central-hosted-agents.md) and `ADP-018` add
one production in-process adapter for an explicitly configured Hosted Agent.
Unlike the Fake Adapter, it performs one real outbound HTTPS provider call.
Unlike managed adapters, it never crosses the Bridge protocol or starts a
local process.

The adapter accepts only a versioned code-defined provider preset, fixed HTTPS
origin, validated model identifier, frozen credential/profile version, bounded
prompt, deadline, and cancellation signal. The initial implementation does not
accept an arbitrary base URL, redirect to another origin, provider proxy,
shell command, filesystem path, environment value, Workspace, Runtime session
ID, or provider tool executor. Provider tool-call output and interactive
approval requests fail closed instead of being rendered as assistant text.

The provider connection test sends one fixed content-free probe and records
only a safe status, code category, and time. Normal execution maps validated
assistant text deltas into ordered `run.output_delta` events and one final
assistant message into the existing reply boundary. The response, decoded
stream, provisional output, and final reply each have independent byte limits;
unknown fields, raw headers, raw error bodies, hidden reasoning, provider tool
protocol, and credentials never become Run events.

The parser accepts `response.created` in either `queued` or `in_progress`
state and a monotonic queued-to-in-progress transition before output. Duplicate,
backward, unrelated, and response-ID-mismatched lifecycle events remain invalid.
This follows the provider's documented
[Responses lifecycle](https://developers.openai.com/api/reference/java/resources/beta/subresources/responses).
Raw delta, part, and final text must agree before their safe projection is
accepted. Control characters are removed before the same ordered redaction
rules apply to both streaming and final text. A stateful redactor retains
possible credential suffixes across deltas and content parts; ordinary safe
text still streams immediately. Only a validated completion may flush the
remaining safe tail, so an interrupted stream cannot publish an unfinished
sensitive value.

`RUN-015` persists the invocation intent and crosses to `dispatching` before
this adapter may open a request. The adapter is not a replay authority. A
Server restart, abort without a trustworthy provider outcome, or ambiguous
stream after dispatch becomes `outcome_unknown`; no provider call is
automatically repeated. A complete deterministic rejection may become a safe
`failed` event with a closed code.

The first version may answer ordinary Runs and participate through existing
handoff/Discussion scheduling, but it cannot submit or review a formal Result,
complete a Task, acknowledge ambiguity, or call Member-, Device-, or MCP-owned
commands. Those are authorization limits, not missing prompt instructions.

## Process and Workspace Safety

Adapters receive an owner-defined Runtime configuration, never an arbitrary
server-provided shell string. They must isolate process groups, bound output,
propagate cancellation, and clean up children. Existing Runtime command, file,
network, and approval policies remain authoritative.

The Hosted Adapter has no process group or Workspace. Its only network
authority is the fixed provider HTTPS origin selected by the supported preset.
It cannot inherit the Server host's filesystem, shell, Docker, desktop, or
Bridge permissions; implementation code exposes none of those ports.

On Unix-like systems each managed Runtime remains in its own process group. On
Windows, `BRG-052` starts every Generic, structured Generic, Codex App Server,
and Pi command suspended, assigns it to a per-Run Job Object configured with
`KILL_ON_JOB_CLOSE`, and resumes it only after assignment. Cancellation,
timeout, Bridge stop, and normal adapter teardown therefore own the same process
tree instead of killing only a `.cmd` shim or parent shell. `CREATE_NO_WINDOW`
remains set, so the stronger ownership boundary does not reintroduce the blank
console window fixed by `BRG-046`.

Immediately before a managed Runtime starts, the Bridge rechecks every pinned
content descriptor against the owner-only materialization receipt, immutable
size and SHA-256, regular-file type, and read-only mode. The resulting local
manifest is bounded by the wire limit of 20 Artifact references and a 1024-byte
absolute path per entry. Each entry exposes the canonical `artifact://` alias,
the Bridge-owned staging `readPath`, media type, size, and digest, and labels the
snapshot as read-only untrusted data rather than instructions. An absent,
extra, stale, or metadata-mismatched alias fails the Run before the Adapter is
called. This local path is not added to the wire contract and does not grant a
new sandbox permission; Codex, Pi, and Generic can read it only when the
owner-selected Runtime policy already permits that access.

Before execution, a new managed native Session projects at most the newest 12
prior Room messages into a 12 KiB named transcript. A resumed Task Session
projects only Messages after its owner-only consumed Room cursor. Both include
the target plus exact
eligible peer Agent names. The Runtime is instructed to use complete
case-sensitive `@Agent name` commands with no fuzzy role or prefix matching.
This improves handoff intent, but the server still parses,
authorizes, depth-limits, and persists every resulting child Run.

## Events and Replies

The shared Bridge executor applies the local `shareReasoningSummaries` consent
after Adapter projection. Missing/false consent withholds reasoning activity
before outbound persistence; enabling it never expands the Adapter's existing
public-summary and redaction boundary. See
[ADR-0018](../adr/0018-local-reasoning-summary-consent.md).

Adapter events carry `runId`, sequence, timestamp, and an optional logical Task
Session disposition/cursor. Native session references and local binding keys
stay local. Text
replies and structured handoff requests are filtered
for obvious credentials and sensitive local paths before leaving the machine.

Managed Task Runs may also carry independently revisioned Room and Task memory
projections. The prompt identifies their source cursor and evidence Message IDs
and treats their content as untrusted collaboration context. A persisted native
session filters already-consumed Room sequences, projection revisions, and
structured result-evidence revisions; a new or recreated Codex Thread receives
the complete bootstrap plan. Artifact summaries remain verification hints and
never grant access to a referenced workspace path.

Content-bearing evidence is injected only when its exact pinned descriptor is
still present in the context page accepted by that native Session. A resumed
Task Session therefore omits both an already-consumed evidence page and its
local alias manifest. A discontinuous delta fails with
`RESULT_EVIDENCE_CURSOR_GAP` before process or turn start. Codex advances the
owner-only evidence cursor only after a successful `turn/start` response; Pi
advances it only after its accepted non-interactive execution completes. A
recreated Codex Thread switches both its prompt and revision bookkeeping to the
full bootstrap projection.

Before any Runtime-originated reply, output delta, activity, clarification,
assessment text, or safe error detail is persisted or sent, the Bridge replaces
every admitted staging path with its logical `artifact://` alias. Streaming
parsers retain a safety tail at least as long as the longest local path, so a
path split across deltas cannot leak a prefix. No configured Workspace file is
created or overwritten by alias injection.

The persisted native binding also tracks long-term Room and Task Memory scope
revisions. A changed scope projects a bounded active snapshot plus recent
superseded/retracted tombstones, with every source ID retained. A complete
snapshot explicitly replaces prior projected Memory state; an incomplete one
warns that omitted entries may still be active. Adapters never promote Runtime
text directly into this central Member-authorized ledger.

Coverage-bearing Room context uses a separate fail-closed path. The Server
bundle contains a checkpoint and raw interval but no guessed local cursor. The
Bridge reads its owner-local binding, chooses the started/resumed/recreated
consumption plan, and verifies interval continuity, exact count, and byte bounds
before invoking the Runtime. It never routes this data through the legacy
12-Message truncation path. Each Adapter defines when a prompt is durably
accepted; only then may the binding advance to the receipt's coverage cursor.
Ambiguous provider acceptance remains explicit and cannot silently skip or
blindly replay context.

Rolling reduction is a distinct execution port, never an ordinary Coding Task
Session. A delegated Bridge worker is explicitly owner-authorized, publishes a
bounded capability and quota, receives redacted Room evidence, and runs without
the Task workspace, tools, shell, or MCP. The Server remains scheduler and
canonical commit authority. A deployment may instead opt into a Server-hosted
runner; no ordinary Agent connection is automatically elected to summarize a
Room.

Result evidence is cursor-driven rather than inferred from the Task's global
revision. A new local Runtime scope receives the newest bounded bootstrap page;
resumed sessions accept only a delta whose `fromRevision` matches their
owner-only binding. Status reports return the opaque scope hash and exact
`throughRevision` only after the native Runtime accepts the page, so a gap,
failed cut, or replay cannot silently skip evidence.

Codex and Generic CLI adapters also recognize an optional final
`agentroom-assessment` XML-style envelope containing JSON. A valid envelope is
removed from the visible reply and sent as structured evidence; malformed or
unsupported output remains a normal reply. The Orchestrator, not the Adapter or
Runtime, owns the resulting continue/finish decision.

Task-scoped managed prompts also describe a separate terminal
`agentroom-clarification` envelope. Codex, Pi, and Generic adapters parse its
closed JSON shape, remove the private marker from provisional output, and emit
`input_required` without a visible reply or `completed` status. The Bridge
persists this as `StateInputRequired`, considers the local execution slot idle,
and replays the event unchanged after restart. A later same-Task Run resumes
through the existing native Session binding.

The envelope is allowed only for missing human Task information. Unknown
fields fail parsing, so permission or approval-shaped objects remain ordinary
text and never become an actionable Server request. Codex interactive App
Server requests continue to receive `-32601`; Pi/local tools and Generic
process permissions remain owner-controlled.

## Verification and Tasks

Shared contract tests must pass for every adapter. Runtime-specific suites cover
startup, native session resume, streaming, activity, named context,
cancellation, crash, recovery, process-tree teardown, and local permission
inheritance. Work is tracked by `ADP-001` through `ADP-017` (completed),
`BRG-023`/`BRG-027`/`BRG-052`, and `RUN-009` in
`docs/TASKS.md`. `ADP-018` implements the Central Hosted adapter without
changing the production Go adapter boundary.

The production Go boundary is `runtime.Adapter`: capability discovery plus one
context-cancelable `Execute` method that emits ordered semantic status, output,
activity, or reply events. The deterministic Go Fake Adapter is the first contract implementation.
The pinned Codex App Server event subset and lifecycle limits are documented in
`docs/codex-runtime-contract.md` and guarded by Go parser fixtures.

## Dependencies

Contracts and the invocation boundary. Bridge adapters depend on Bridge; the
Hosted adapter additionally depends on Security for credential resolution and
Run Orchestration for its durable intent. Adapters never call Team services
directly.
