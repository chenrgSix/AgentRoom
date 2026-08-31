# Repository Execution and Verification

- Prefixes: `REPO`, `VER`; local coordination also uses `WSP` and `BRG`
- Planned implementation: `apps/server/src/repository/`,
  `apps/server/src/verification/`, `bridge/internal/repository/`
- Governing decision: [ADR-0036](../adr/0036-add-governed-software-team-execution.md)
- State ownership: Central owns operation intents and authenticated receipts;
  Bridge owns local bindings, paths, permissions, Git and command execution

## Local Repository Binding

An owner explicitly registers a local Git repository, safe display alias,
runtime profile, verification profiles and integration target allowlist. The
binding has an opaque binding ID, authorized logical repository ID and local
policy revision; absolute paths,
remote URLs, credentials and executable argument arrays never leave the host.
An Agent's ordinary Workspace binding does not implicitly register a repository.

Central receives only capability metadata needed for admission. Registration
does not scan arbitrary folders or execute repository hooks. Local validation
rejects non-repositories, ambiguous roots and bindings outside owner-approved
roots. Repository identity is stable across ordinary commits but not silently
rebound to another checkout. Each Bridge advertises its own binding and exact
object availability; a same-looking display alias proves nothing across Devices.

`repositoryId` is the collaboration identity; `bindingId` is one Device-local
checkout. An authorized human explicitly admits each binding into the logical
repository. Integration serialization and configured remote identity are keyed
by logical repository and target ref across Devices, not per checkout. Local
operations additionally require the exact binding and its owner-local grant.

The first owner entry is the local Bridge `repository bind/list/revoke` CLI,
described in [Local Bridge](bridge.md#explicit-local-repository-registration).
Its immutable registration pins physical Git identity under exact paired-owner
scope and its separate revocation never deletes a checkout. It intentionally
does not emit a wire capability, grant Task operations or establish cross-Device
logical-repository membership. The separate `repository grant issue/list/revoke`
CLI records exact owner-local Task consent as described in
[Local Bridge](bridge.md#explicit-local-task-consent). Runtime/verifier profile
resolution and enforced admission remain part of BRG-071 rather than being
inferred from either registration or consent.

## Operation Contract

CON-021 defines the shared version-1 wire shapes in
`work/execution-runtime.schema.json`. A request has a closed discriminated
`action`: `{ kind: "prepare", prepare: { ... } }`, and equivalently for capture,
verify, integrate, publish and observe. Operation-specific nullable values stay
inside that operation's payload, preserving exact generated Go serialization.
Wire validity is separate from local admission and journal transitions; the
schema does not create a repository binding, grant, verifier or side effect.

Closed operations are prepare, capture, verify, integrate, publish and observe.
Each has an immutable operation ID, normalized request digest, plan/node/Run
scope where applicable, repository identity, expected object IDs and generation,
local grant reference, deadline and bounded outputs. State is `planned`,
`prepared`, `started`, `succeeded`, `failed`, `canceled` or `outcome_unknown`.
This journal describes a repository side effect, not a second Agent Run.
Only its authenticated Device/runner may settle an operation. Exact retries
return one receipt; changed payload, actor or generation is rejected.

Repository-generated Git commands use fixed argument arrays and explicit
validated refs/object IDs, with option termination where supported. Remote
requests cannot supply arguments, hooks, scripts, environment or file paths.
Automation does not execute user-controlled hooks as an incidental side effect.
Verification commands are a distinct locally approved profile with its own
sandbox, environment allowlist, limits and audit record.

## Grants and Runtime Admission

A TaskScopedGrant names the local repository, owner-approved plan/node/Agent
scope, allowed operation kinds, runtime/verifier profile fingerprints,
integration targets, expiry and policy generation. Grant lookup, capability and
revocation checks occur before preparation and immediately before execution.
The effective capability is an intersection, never a union of central request
and local configuration. Read-only reviewers cannot request writable worktrees.
Grant secrets and local administrative endpoints are unavailable to runtimes.

The local consent store pins the compiled Task definition/criteria, exact plan
revision/digest, selected base and physical registration fingerprint in addition
to the generated grant summary. It preserves immutable issuance and separate
digest-bound revocation under the same process-owner fence as registration.
Current consent checking is one prerequisite, not a Runtime or verifier service;
no production governed capability is advertised by this increment. Actual
profile resolution, enforced execution and in-flight revocation remain required.

The first Codex-specific admission foundation is a native macOS local boundary
probe, described in [Local Bridge](bridge.md#codex-local-boundary-probe). It
verifies an exact closed named-profile definition plus real workspace-write,
outside-read/write and controlled IPv4 loopback-connect behavior. It is neither
a profile registry nor reusable authorization. The current installed Codex
executable fails the outside filesystem check before a combined positive result,
so the production capability remains closed rather than falling back to a
generic Runtime or treating local Task consent as sandbox evidence.

The initial governed runtime path must enforce the actual Workspace boundary.
Unsupported Generic/manual/hosted configurations reject governed coding while
retaining ordinary work. Owner-approved verification runs in an isolated
environment without inherited deployment credentials or writable external
checkouts. A successful verification does not imply the tested code is safe.

Path scope policy uses normalized repository-relative paths and rejects
traversal, absolute/drive paths, empty components, control characters and unsafe
Git metadata paths. Allowed/forbidden prefixes have deterministic separator-aware
matching; forbidden wins. The scope gate considers tracked/untracked files,
deletions, renames, executable mode changes, symlinks and submodule changes.
Post-run scope checks gate publication/integration; preventive per-path access
requires separately supported local enforcement. These claims stay explicit in
capabilities and the UI.

## Worktree and Checkpoint Lifecycle

Preparation records a durable intent, resolves the approved full base object,
allocates one owned directory/branch, creates a worktree and records its actual
identity before Runtime admission. Concurrent attempts never share writable
directories, branch refs, session bindings, temporary build roots or test ports.
Input application pins exact predecessor patches/commits and deterministic
order. Dirty or conflicting inputs fail with diagnostics and no target mutation.

Capture requires the Run/operation and current local grant, checks scope,
collects exact diff/tree/base metadata and publishes bounded canonical content.
It records a checkpoint before making the workspace eligible for cleanup.
Checkpoints are immutable code/evidence observations, not OS process snapshots.
Resume/retry explicitly chooses a collected checkpoint and creates a new
attempt; an unknown old process is never silently reattached or duplicated.

The owner-visible cleanup command previews exact recorded worktrees and
branches. It excludes active/unknown operations, uncollected changes, foreign
directories and refs that moved outside the recorded ownership. It uses Git's
worktree lifecycle, verifies identity again and retains an audit tombstone.
No recursive workspace-root cleanup or automatic deletion of user changes is
permitted. Tests use temporary directories and register cleanup immediately.

### Exact Local Worktree Retirement

`PreviewCleanup` and `CleanupWorkspace` implement the local Git retirement
primitive. Both require an explicit `CleanupAuthority` callback that holds the
existing stopped-Run fence and current owner-local cleanup authorization for the
exact plan/node/Task, Run, Device/Agent, repository/binding, workspace generation
and checkpoint. A missing guard fails closed. This is a synchronous internal
adapter contract, not a serialized `stopped=true` field, new Run state machine,
or assertion that production BRG-071/RUN-018 admission is already implemented.

Preview performs no mutation. It verifies the confirmed canonical checkpoint,
publication/observation history and retained patch, then checks current file
hashes twice, index identity, branch HEAD, physical directories and Git worktree
registration. Extra refs/worktrees, locked/prunable registrations, replacement
directories, changed Git configuration and any uncollected tracked, untracked,
ignored, deleted or staged changes make the preview ineligible. Captured but
uncommitted changes are eligible only when every observed byte and mode still
matches the sealed snapshot; a clean `git status` is not proof of collection.

Confirmation supplies only the operation/checkpoint and exact preview digest,
never an arbitrary local path. Current authority and physical state are checked
again before an immutable intent and workspace retirement claim are recorded.
Preparation refuses a workspace once its retirement claim exists. Git removes
only the recorded worktree; branch deletion uses its exact expected old object.
Step receipts and a final immutable local tombstone preserve response-loss
replay. Fully completed Git effects can be reconciled after reopening, but a
partially removed tree, moved ref, changed step record or replacement remains
an explicit incomplete/unknown outcome, not a blind force retry or broad prune.
Historical completed replay does not delete a later recreated directory.

This command retires a worktree and branch, not all retained storage. Preview
explicitly identifies the private Git object store, scratch diagnostics and
checkpoint store that remain. Cleanup never recursively sweeps those stores,
and the checkpoint remains usable for an explicitly authorized new attempt.
This retention policy avoids treating uncollected scratch diagnostics as cache
garbage and does not claim a total disk quota or storage-purge feature. Owner UI,
actual local cleanup-grant/Run fencing and recovery decisions still require the
production Bridge admission and product-surface work; no capability is advertised
by this local primitive alone.

### Local Pinned Preparation

`bridge/internal/repository.Preparer` is an owner-local Git primitive, not a
second wire model or a Runtime admission service. Its local-only `Source`,
`Preparation` and `PreparedWorkspace` values contain paths and must never be
published as central metadata. The later Bridge admission adapter must validate
the authoritative execution request, current local grant and exact selected
input bindings before invoking it, and must retain the existing durable Run
start fence afterward. A preparation receipt never establishes that an Agent
started, a Result was accepted or a repository checkpoint was published.

Source inspection requires an explicit owner-selected exact repository root
inside allowed roots, including its Git metadata. Physical directory identities
and the resolved Git/common-directory and object format are rechecked; moving
HEAD is allowed, replacing or retargeting the binding is not. Alternate object
stores are unsupported and rejected. A dedicated private owner directory keeps
exclusive process ownership and immutable operation/Run/workspace claims.

Each attempt imports only its approved full SHA-1/SHA-256 commit and tree/blob
closure into an independent bare store, with that exact commit as a shallow
boundary. It creates an owned `codex/` branch and linked worktree there, never
in the source repository. It neither imports ancestor history nor inherits
source/global configuration, remotes, hooks or external filters. Owned attributes
materialize canonical blob bytes without encoding, EOL or ident conversions;
this is an explicit snapshot policy, not an assertion that arbitrary custom
checkout filters are supported. Gitlinks remain unpopulated and symlinks remain
links; unsupported platform materialization fails rather than changing their
meaning.

Ordered patch inputs are digest-checked before mutation. Binary literal and
delta output expansion is bounded before Git application; the resulting tree
is checked again against entry, byte and portable-path limits. Local defaults
are 128 MiB logical snapshot/patch-expansion budgets, 100,000 tree entries and
60 seconds per Git command. These bound individual operations, not a total
on-disk quota across retained attempts. Missing objects never trigger a fetch.

Preparation seals an immutable candidate before checkout and a local receipt
after actual file hashes, modes, branch, tree and Git linking identities agree.
It does not trust status/index flags or ignore rules to prove clean contents.
Exact replay can finish a sealed candidate or recover a lost preparation
receipt; dirty, replaced or partially unsealed attempts are retained and fail
closed. It never resets an existing directory or retries a possibly running
Agent. Journal files are synced and atomically installed without replacement;
Windows flushes owned read-only Git files with write-capable handles and restores
their attributes. Native Windows and power-loss durability need their own
platform evidence; cross-compilation does not establish either.

### Explicit Local Checkpoint Resume

`PrepareFromCheckpoint` consumes the generated prepare operation, its exact
`resumeCheckpointId`, a canonical checkpoint already confirmed by this Bridge,
and freshly authorized upstream patch bindings. The retained publication intent,
checkpoint proposal, confirmed receipt and captured bytes must all agree. An
unconfirmed proposal, missing/corrupt bytes or another local repository binding
cannot stand in for that history. The source checkout is revalidated; the old
attempt's working files are never read or restored, even if they contain later
uncollected changes. This is local code restoration, not native-session resume
or cross-Bridge checkpoint import.

The new attempt retains the same approved plan revision, node, Task definition
and criteria, Agent/Device, base, runtime profile, scope, verification and output
contract. It uses a different Run, lease, workspace and workspace generation,
with an increasing dispatch generation. Task/control revisions may advance and
a grant may be renewed; current local authority and stopped-Run/explicit-retry
admission remain mandatory caller responsibilities, not properties conferred by
the checkpoint. Existing production Runtime admission remains fail-closed.

Upstream identity compares exact receipt, Artifact, content, repository, slot
and order. Input binding IDs, destination Run and validity intervals are renewed
for the new attempt, so its complete input digest need not equal the old one.
New bytes must match those new bindings. Changed upstream content is not an
implicit rebase: it requires a separately approved reconciliation.

Resume journal version 3 freezes the selected checkpoint and request digests.
The adapter rebuilds the approved base plus upstream inputs, applies the sealed
Task patch, and checks that the actual Git tree equals the selected checkpoint.
It separates the Runtime starting commit from `outputBaseCommit`: subsequent
scope checks and output capture use the latter so the patch includes cumulative
Task changes without re-exporting upstream work. Repeated resume without new
edits still preserves that cumulative patch. Both input and checkpoint patch
expansion consume one local budget. Ordinary version-2 journals omit the new
fields and preserve their exact digest encoding.

A sealed candidate can finish checkout after restart and a lost local ready
receipt can be recovered through actual file/identity checks. Changed replay
intent, dirty new worktrees and incomplete unsealed candidates fail closed and
remain available for inspection. This operation creates neither a Run nor a
Runtime, and it does not release a workspace, accept a Result or authorize
cleanup. Runtime wiring, owner-visible cleanup and remaining output producers
retain their separate acceptance requirements.

### Frozen Output Scope and Local Capture

Preparation journal version 2 also pins the generated `ManifestScopePolicy`.
Read-only means no output changes, allowed prefixes are separator-aware, and
forbidden prefixes always win. Invalid or fully forbidden write scopes fail
before preparation. Version-1 local observations cannot acquire an implicit
write scope; they remain historical and cannot enter capture through the new
API. No production Bridge advertised the earlier primitive as an execution
capability.

`Capture` accepts recorded operation/workspace identities and exact prepared,
generation and manifest digests, never a new path policy. Its caller must hold
the existing Bridge stopped-attempt fence and current local authorization;
capture does not invent another authoritative Run state or prove process death
from a clean filesystem. The original source, Agent branch, index and worktree
remain unchanged.

Actual files are read through a rooted filesystem and observed twice with
head/index consistency checks. The approved base plus exact upstream inputs is
the output-scope baseline, not the original repository commit alone. For a
resumed attempt this is its explicit output base, not the checkpoint-derived
Runtime starting tree.
Tracked, untracked and ignored files are all considered. Generated build state
must be placed in locally approved attempt scratch or explicitly handled by its
owner before capture; mutable ignore rules cannot conceal out-of-scope writes.
Renames are checked as deletion plus addition so both endpoints need authority.
Changes to symlinks/gitlinks and unresolved index stages are rejected. Existing
unchanged symlinks/gitlinks remain part of the pinned snapshot. Owned Git
metadata rejects symlinks, special files, redirected intermediate directories
and changed configuration/shallow/graft boundaries before Git reads it. Windows
uses index modes for executable metadata rather than claiming POSIX mode support.

Capture creates a separate immutable Git store from bounded, verified bytes,
checks its objects and exact inventory, and generates a full-index binary patch.
Its current patch ceiling is 4 MiB, matching canonical Artifact transport;
larger output is retained as an unpublished candidate, never truncated or
silently promoted. Temporary blob copies are deleted by exact enumerated names
only after the independent object store is flushed. Local inventories are
bounded to 32 MiB and never become wire manifests.

The sealed local `CapturedRepository` record survives restart and exact
response-loss replay without observing later uncollected edits. A final receipt
can be regenerated only from its immutable intent/candidate and matching output
bytes. A generation cannot acquire a different capture identity. A partially
unsealed capture remains inspectable and cannot be blindly rerun with different
bytes. This record has no canonical Artifact IDs and is not a
`RepositoryCheckpoint`, verifier receipt, completion decision or cleanup grant.
Formal checkpoint publication must use actually accepted canonical content
receipts; the legacy `read_source` publisher cannot impersonate an isolated
workspace lease.

### Canonical Capture Publication

An authenticated capture operation is pinned to the existing Run manifest and
active isolated lease. It issues a derived `read_capture` content lease, not a
default-Agent `read_source` lease and not additional filesystem permission.
The existing Artifact upload/seal/bind channel carries the actual bytes; capture
authority is rechecked before new writes and binding. Exact, already-committed
receipts remain readable for response-loss reconciliation. Neither channel
may treat a governed Run's default Agent workspace as its execution workspace.

Checkpoint sealing requires the original operation/scope, exact base/input and
workspace pins, approved output slots, and same-operation canonical Artifact
identities whose stored bytes still match their declared digest and size. The
checkpoint is immutable and unique per capture operation. Sealing it does not
verify the code, accept a Result, advance Run state, merge, or authorize cleanup.
The enrolled Bridge is the code-observation authority; Central does not infer
an actual Git tree merely from Artifact bytes or Agent prose.

### Bridge Capture Publication Adapter

`Preparer.PublishCaptured` binds a sealed local capture to the generated frozen
manifest and capture operation. It verifies canonical digests, scope, repository
and workspace identities, prepared patch-input pins, captured time and selected
required output slots before any HTTP request. The caller must still hold the
current owner-local authorization and stopped-Run fence; this is not a new
Runtime admission path. The local adapter publishes non-empty sealed patch,
Markdown document, JSON test-report and incremental Git commit-bundle outputs.
It rejects unsupported selected kinds or missing required slots instead of
omitting them or fabricating content or verifier observations.

The private owner journal retains exact publication intent before network IO,
then an exact checkpoint proposal before sealing, and finally the confirmed
canonical receipt. Restart first queries the Server's exact operation identity.
A committed checkpoint is accepted only when it matches the retained proposal;
an unsealed proposal is replayed exactly. Previously bound content is recovered
through the canonical Artifact bind receipt, including its actual revision.
Unknown/forbidden/unavailable lookups are never interpreted as absence.
Confirmed local receipts are read-only replay results, not renewed authority.

The Artifact client's capture path obtains `read_capture`, validates the exact
lease projection and sends only captured bytes and safe metadata. It never
refreshes the default Agent workspace or obtains `read_source`. Operation and
output-slot identities namespace publication idempotency. A changed intent,
generation, digest or receipt fails without rebinding historical output.
The source checkout, captured worktree and later uncollected changes stay
untouched; publication does not authorize their cleanup.

Document and test-report selectors are local, portable repository-relative paths
inside the frozen allowed output scope; forbidden prefixes win. They address
only regular blobs in the sealed candidate, not live Workspace files or arbitrary
local paths. Before any HTTP operation, every selected output is checked against
capture intent, physical store identity, Git configuration/object integrity,
candidate tree and snapshot inventory. Individual report blobs also verify their
Git object hash, SHA-256 content digest and 1-byte through 4-MiB transport bound.
Documents require UTF-8 `.md`/`.markdown`; reports require UTF-8 valid `.json`.
Wire filenames derive from slot identities, not the local report selector.

Report JSON is supplied content only, including any purported pass/verification
field it contains. It never creates a VerificationReceipt, accepts a Result or
completes a Task. Selected paths are pinned in local publication intent, even
when two paths contain identical bytes. The optional selector is omitted for
patch outputs so existing patch-only journal encoding and digests stay unchanged.

A report-only capture may have no code delta when no patch output is selected;
a required empty patch is still rejected rather than published as an empty
Artifact. Such a confirmed checkpoint can resume under a new attempt: its empty
patch has the exact empty SHA-256 digest, application is a no-op, and the rebuilt
tree must still equal the selected checkpoint. Both reports and patches remain
available after exact worktree retirement because their sealed store is retained.

The actual Go/HTTP/Git integration fixture verifies canonical uploaded bytes
against the captured tree through response loss and separate-process restart.
It supplies synthetic future-admission/connection metadata and fixture code
changes, not an Agent Runtime or local grant implementation. Its resume extension
uses a confirmed Server checkpoint in a new Go process and checks that newly
published cumulative bytes reproduce the new actual candidate tree. A local
retirement extension previews, deletes and replays through separate Go processes
without mutating Server checkpoints or Run state. The report extension verifies
four distinct canonical output slots including commit, late uncollected report
edits, resume and retirement without promoting report claims into acceptance.
A separate Git consumer verifies actual canonical bundle bytes, commits and trees
on both object formats without promoting a ref. Production cleanup authority and
UI, and the BRG-071/RUN-018 admission connection remain required product work.

### Retained Commit Bundle Producer

`ReadCapturedCommitBundle` creates bounded standard Git bundle v3 bytes from the
same verified sealed candidate used by report publication. The bundle advertises
only the capture-owned candidate ref and requires the exact prepared output-base
commit, including approved upstream inputs. The original repository base cannot
substitute for that prerequisite. Only new candidate objects are transmitted;
unchanged source blobs and prerequisite history are not a full-repository backup.
The prerequisite comment is fixed text, not the source commit's subject.

The owner-local journal pins the capture digest, prerequisite, object format,
SHA-256 and byte length. Replay returns the identical retained bytes after reopen
or exact worktree retirement; content written before its receipt can recover only
when recomputation matches. Changed identities, configuration, checksums, extra
refs/capabilities and outputs above 4 MiB fail closed. The envelope checks do not
replace Git object validation: actual SHA-1/SHA-256 consumer tests verify and
unbundle into a separate prerequisite repository, then check commit, parent,
tree and object integrity without moving consumer refs.

`PublishCaptured` now publishes these retained bytes only for an approved commit
slot, through the existing capture-only Artifact channel using a slot-derived
`.bundle` filename and `application/x-git-bundle`. Neither patch nor commit
outputs accept a local path selector. A commit-only, no-code-delta capture is
valid because the bundle still contains an actual candidate commit object.

Canonical binding reads the candidate ID from the sealed envelope, rather than
accepting a caller label. Checkpoint sealing requires the Artifact and envelope
candidate to equal the checkpoint. Object formats must agree; without
code-changing inputs, the prerequisite must be the approved base. With such
inputs, the exact prepared prerequisite must be present and verified at the
Git consumer; central envelope validation is not object verification.

The local retention receipt remains private metadata, not a second wire contract.
Publication does not import code into a governed downstream Run, grant Runtime
access or authorize integration. See the historical
[producer evidence](../acceptance/repo-004-commit-bundle-producer.md) and
[canonical transport evidence](../acceptance/repo-004-commit-artifact-transport.md).

## Verification Receipts

Verification is a system-owned operation on an exact candidate, not an Agent's
permission to upload trusted JSON. Local profile IDs resolve to owner-local
commands and isolation settings. The receipt binds profile version/digest,
runner, code commit/tree, task definition/criteria, selected inputs, Run or
integration operation, duration, exit classification and sanitized log Artifact.
Different-profile or different-tree receipts cannot satisfy a gate. A canceled,
timed-out, malformed or unknown verifier is never a pass.

Agent self-reports remain Result claims. Reviewer findings remain attributed
review evidence. Human Task acceptance remains in ResultService. Central trusts
an explicitly enrolled verifier host/CI authority for observation provenance;
it does not claim cryptographic proof against a compromised host. Ordinary
Agent/MCP/Artifact APIs cannot mint verifier receipts.

## Integration Queue

An explicit approved operation pins logical repository, allowed target ref, expected
target commit and required node outputs. At most one started integration exists
per logical repository/target across all Device bindings. Preparation constructs a candidate in a separate owned
workspace; source worktrees remain unchanged. The exact candidate must pass
scope, required verification and human integration approval before target CAS.
Conflict creates actionable attention and retains inputs; no force resolution.

If the target moves, a new candidate and verification are required. Git update
uses expected old object ID; an old green receipt cannot authorize a new tree.
A successful local target update is recorded separately from remote publish or
PR state. Task acceptance is not itself merge approval. A plan's chosen
integration policy is explicit: reviewed local candidate, local integration or
configured remote PR/merge observation, with distinct completion evidence.

## Remote Git, CI and PR

Remote operations are opt-in owner-local bindings. The first adapter has a
closed supported provider interface and fixed HTTPS origin/repository identity;
no arbitrary URL supplied by Agent output is fetched. Credentials remain local.
The operation records exact expected remote ref and object IDs before push.
PR creation uses a stable operation marker and exact head/base identity; a lost
response is reconciled by lookup before creation is retried. Ambiguous or
multiple matches stop for a human. Never use force push to resolve uncertainty.

CI observations bind provider, repository identity, workflow/check identity,
candidate commit, attempt and status. A URL or Agent claim is insufficient.
Callbacks/polls must authenticate the configured source; stale runs, unrelated
checks and different candidate commits cannot satisfy required verification.
Provider adapters have real local HTTP acceptance with response-loss injection;
live external execution is reported separately and is never implied by mocks.

## Security and Failure Matrix

| Condition | Required behavior |
| --- | --- |
| unknown/missing capability or expired grant | reject before mutation; no silent fallback |
| source Task or destination Run is unauthorized | reject delivery/materialization |
| snapshot/target generation changed | conflict, preserve original intent |
| old Run is outcome_unknown | do not prepare a replacement writer automatically |
| worktree exists after response loss | verify journal, path ownership and exact base before reuse |
| untracked/out-of-scope/symlink output | reject publication/integration; retain diagnostic workspace |
| verify succeeded but receipt was lost | replay stored receipt for exact operation |
| target update may have committed | inspect exact target; confirm or keep unknown |
| remote push/PR response was lost | authenticated exact-identity lookup, no blind duplicate |
| cancellation raced with success | first trustworthy durable outcome wins; retain diagnostics |
| task/plan was superseded | preserve historical receipts; block incompatible new use |

## Verification and Commands

`REPO-004` covers real temporary Git preparation, capture, approved output
production, checkpoint resume and exact cleanup primitives. The earlier
REPO-001-named evidence files remain valid historical evidence for those
primitives and are not renamed. Producing approved Artifact content, including a
`test_result` report, does not produce an independent verification receipt;
that separate authority remains VER-001 and is not a hidden prerequisite of the
local content producer. `BRG-071` connects owner binding/grant setup,
runtime enforcement and owner-visible cleanup to the existing stopped-Run
authority. `RUN-018` connects those capabilities to ordinary frozen Run Delivery.
`REPO-001` retains the full owner-local lifecycle acceptance using these actual
production adapters, and is a prerequisite of QA-052 rather than of its own
BRG-071 implementation. Local fixtures alone cannot satisfy that closure.

`VER-001` depends on the local primitives and actual local enforcement, not the
later lifecycle acceptance; it runs actual
bounded commands with pass/fail/timeout and forged-receipt negatives;
`REPO-002` exercises overlapping branches, conflicts and target CAS;
`REPO-003` validates authenticated provider IO and ambiguous external effects.
`QA-052` through `QA-055` combine these with actual Server and Go Bridge
processes, browser entry and direction auditing. Delivery state stays in TASKS.

Build/test Server through its existing npm workspace commands. Bridge code uses
`gofmt`, `go test ./...`, `go test -race` for affected packages and `go vet ./...`.
Cross-platform compilation is not native Windows/macOS behavioral acceptance;
report those gates independently. New APIs and wire data require generated
TypeScript/Go contract checks and interoperability tests.
