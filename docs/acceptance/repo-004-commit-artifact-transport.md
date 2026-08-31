# REPO-004 Canonical Commit Artifact Transport

Date: 2026-09-01. Scope: approved captured commit output, canonical transport,
storage/wire compatibility and real local Git consumer verification. This is
the local-output foundation, not governed Runtime or two-Bridge acceptance.
Delivery status remains solely in TASKS.

## Implemented Boundary

The capture publisher selects retained bundle bytes for approved commit slots;
no local path selector, arbitrary archive or metadata-only substitute is accepted.
The existing Artifact channel uploads bounded `.bundle` content under
`application/x-git-bundle`, obtains one canonical Artifact identity and binds it
to the immutable checkpoint. Every output is collected before the first HTTP
operation. Commit-only captures also work without a code delta: an actual Git
commit object remains in the bundle.

The Server permits binary commit publication only from the exact active capture
lease. Both ordinary source APIs and the independent SQL lease trigger reject
commit uploads from `read_source`. Envelope validation precedes sealing and any
file mutation. A rejected upload remains intact under existing expiry/quota
rules, so DB transaction rollback cannot leave acknowledged bytes missing.

Binding derives the full candidate ID from verified sealed content. A checkpoint
requires that same Artifact/envelope candidate and object format; absent
code-changing inputs, the prerequisite must match the approved base. Prepared
input prerequisites still require exact Git objects at the consumer. Central
parses the closed envelope and checksum, not arbitrary Git object semantics or
test validity. Local Git integrity and independent Task verification remain
separate authorities.

## Storage and Compatibility

Migration 0063 changes only the two canonical content tables' supported type and
media constraints, preserving row/column order, all original indexes and
immutable/scope/lineage triggers. Tests retain bound patch/document/test-result
content, their relations, a pending upload, Task/Run rows and actual Blob bytes.
A deliberate failure after rebuilding proves that schema, data and migration
state roll back; successful migration and idempotent rerun check all foreign
keys. Older populated migration entry points also run through version 63.

Eight shared TypeScript/Go fixtures cover SHA-1/SHA-256 snapshot descriptors and
missing/short/wrong-width commit IDs, wrong/unknown media and mismatched Artifact
kinds. Generated types and validators remain the authoritative wire model.

Ordinary Run context retains reference-only commit metadata, not a binary content
descriptor; its download allowlist remains unchanged. The existing execution
input endpoint requires its independent exact destination-Run binding before
reading selected bytes. Nothing here imports objects into a real governed Run.
Web shows binary metadata, suppresses text preview/import/execution controls and
preserves all existing text previews. Server preview explicitly rejects binary
content. These are compatibility changes, not completion of WEB-063/WEB-064.

## Actual Process Evidence

The existing Go/HTTP/Git fixture now publishes a required commit in all four
response-loss/restart scenarios. Its SHA-256 case loses a bound response; the
SHA-1 cases cover lost checkpoint responses, committed-but-unavailable lookup
and uncommitted retry. All reconcile one canonical Artifact per slot, retain
exact revisions and produce no additional writes on confirmed replay.

A separate actual Git consumer reads canonical Server-stored bytes, verifies
and unbundles them, runs strict fsck and checks candidate, parent, tree and file
content while keeping refs and its checkout unchanged. The mixed-output case
also checks patch, Markdown and JSON outputs, then resumes into a new attempt
and verifies the new commit after exact worktree retirement. Task acceptance and
Run lifecycle remain unchanged by publication. Ordinary Context Planner output
is inspected to prove the binary descriptor is absent.

Negative HTTP cases reject malformed envelopes repeatedly without losing their
uploaded bytes, mismatched checkpoint candidates and wrong prerequisites. The
synthetic pack used for envelope negatives is explicitly not object-validity
evidence; only the actual Git fixture supplies that proof.

All execution admission/connection metadata and code-writing actions in these
fixtures are explicit test inputs. This is real Server/Go/Git on one local host,
not a real Agent Runtime, two physical machines, a verifier or an external Git
provider. No live user repository, PR, branch target or deployment is changed.

## Direction Review

The change completes actual content production instead of treating checkpoint
commit labels as deliverables. It reuses Artifact identity and the existing
transport, preserves Task/Run/Result ownership, scopes permissions to capture,
and retains ambiguous-operation reconciliation. It adds neither an execution
start path nor an automatic retry, merge or acceptance decision.

BRG-071/RUN-018 must connect owner grants, enforced Runtime boundaries and frozen
delivery. REPO-001 retains production cleanup/lifecycle closure; EXEC-003 retains
all independent input gates and real two-Bridge materialization. VER-001,
integration/CI/PR, complete Web flows, bounded autonomy and the final direction
audit remain required parts of the original objective.

## Validation Record

The implementation was checked with Node 22.23.1, Go 1.26.7 and native macOS Git.
All commands below exited successfully; no failure was converted into a skip.

- `npm test`: Server 474, Web 254, Node contracts 78, embedded Bridge UI 56,
  acceptance-evidence verifier 45, product fixtures 2 and website 15 tests pass.
- `npm run build` and `npm run validate`: all workspace builds and 11 registered
  schemas with 240 shared fixtures pass. The existing Web large-chunk warning
  remains a build warning, not a failed or waived check.
- The final `repository-capture` and `commit-bundle-envelope` focused run passes
  all 24 cases after tightening the no-code-input prerequisite check. Server
  build was repeated successfully afterward.
- The actual Go/HTTP/Git publication fixture passes all four recovery modes;
  together with its parent Node case this reports five passing tests.
- `go test -json ./...`: 351 top-level tests and 24 packages pass. Five explicit
  helper-process entry points skip when invoked without their fixture flags;
  their callers execute them where required. The operations package has no tests.
- `go test -race ./internal/repository ./internal/artifact`, full Bridge
  `go vet ./...` and native Bridge CLI build pass. Windows amd64 and Linux amd64
  repository test binaries cross-compile; this is not native-platform execution.
- `npm run test:e2e`: seven deterministic compatibility scenarios pass; the
  opt-in live-provider scenario is skipped and is not claimed as acceptance.
- `git diff --check` and `npm run lint:docs` pass across 307 maintained files.

The Web changes were verified by component tests and production build, not a
new interactive browser acceptance. The implementation does not advertise the
unfinished governed-execution capability or change its existing no-start fence.
