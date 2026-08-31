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
head/index consistency checks. The prepared candidate, including exact upstream
inputs, is the output-scope baseline, not the original repository commit alone.
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

`REPO-001` covers real temporary Git preparation/capture/cleanup;
`BRG-071` covers local policy and runtime enforcement; `VER-001` runs actual
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
