# REPO-001: Go Capture Publication

Date: 2026-09-01. Scope: the Bridge-local sealed-patch publication increment of
ADR-0036. Delivery state remains only in `docs/TASKS.md`.

## Implemented Boundary

`Preparer.PublishCaptured` validates the generated frozen manifest and capture
operation against retained preparation/capture identities and exact bytes. It
retains publication intent before network IO, a complete canonical checkpoint
proposal before sealing, and the confirmed Server receipt afterward. Exact
restart queries the operation's checkpoint before any upload or seal replay.
Changed descriptions, inputs, generation or other intent fields conflict rather
than changing already published work.

The Go Artifact client uses the existing authenticated HTTP transport and
publication/chunk/seal/bind channel, but obtains and validates `read_capture`
instead of refreshing the Agent's default Workspace or requesting `read_source`.
Operation/output-slot namespacing preserves one publication identity per selected
output. It uses CON-022's generated raw validators and exact canonical digest.

The shared uploader now recovers the actual Artifact revision after a lost bind
response. Its former status-only success returned revision zero because the
publication projection does not contain that value. Exact idempotent bind replay
returns the actual canonical Artifact and revision; missing or contradictory
revision/content/Artifact pins fail. Existing ordinary publication keys remain
unchanged. All source filenames must satisfy the existing alias-safe policy.

## Real Git, Go Process and Server Evidence

`apps/server/test/repository-capture-go.test.ts` compiles the actual Go repository
and Artifact packages into a disposable test executable. Each scenario creates
an independent temporary Git repository, approves a plan pinned to its actual
base commit, prepares/captures through Go and publishes to the real Server over
HTTP with Device authentication. A loopback fault proxy drops selected responses.

Four scenarios pass:

1. Lost first bind and checkpoint responses reconcile through canonical reads.
2. Binding commits but both receipt responses are lost. A new Go process retries
   the exact publication identity and reads its real Artifact revision.
3. Checkpoint commits, its response is lost and lookup is temporarily unavailable.
   A new Go process finds the committed checkpoint without publishing again.
4. The checkpoint request is disconnected before reaching the Server. A new Go
   process observes absence and replays only the retained checkpoint proposal.

Each scenario checks that the Server has exactly one publication, canonical
Artifact, checkpoint and checkpoint output. The actual stored Blob is read with
digest/size verification, applied to a separate checkout of the approved base,
and produces exactly the captured Git tree. The original source HEAD and working
tree remain unchanged. Later uncollected edits in the Agent worktree neither
change the old patch nor disappear during restart. Replaying a confirmed local
receipt makes no HTTP calls; changing its intent fails before HTTP. No local
source/state paths enter requests, and no default source snapshot/lease endpoint
is called. Run state remains unchanged throughout.

The test's future-admission Run and connection capability metadata are explicit
synthetic fixtures. Code changes are fixture writes, not Agent invocations.
Production governed-Run rejection remains intact. This proves actual local Git
and Go/HTTP publication, not local grant enforcement or Runtime startup.

## Regression and Negative Checks

Commands ran on macOS arm64 with Node 22.23.1 and Go 1.26.7, using task-scoped
temporary and Go cache roots:

```sh
node --import tsx --test --test-reporter=spec --test-concurrency=2 \
  apps/server/test/repository-capture-go.test.ts \
  apps/server/test/repository-capture.test.ts \
  apps/server/test/isolated-workspace-lease.test.ts
npm run build
npm run test --workspace @convene-wire/server
npm run test:e2e
```

From `bridge/`:

```sh
go test -json ./...
go vet ./...
go test -race ./internal/artifact ./internal/repository
go build ./cmd/convenewire-bridge
```

Observed results:

- 40 focused Server assertions/cases pass, including the four real Go process
  fault scenarios; all 465 Server tests and all workspace builds pass.
- All 321 top-level Go Bridge tests across 24 tested packages pass. The three
  existing browser helper entrypoints and new Server-driven process entrypoint
  skip standalone invocation; the new entrypoint is exercised by the real HTTP
  scenarios, not counted as a standalone pass.
- Four new Artifact-client test groups exercise 37 cases: changed manifest/scope,
  grant/binding/Device/approval/deadline/output/source/filename before HTTP;
  wrong lease pins and case aliases before upload; explicit absence versus
  forbidden/unavailable/wrong-receipt lookup; and invalid bind revision/content
  identities. The existing lost-response test now asserts revision 7 on both
  initial recovery and later exact replay.
- Go vet and Artifact/Repository race checks pass. The repository test executable
  cross-compiles for Windows/Linux amd64, and the native Bridge CLI builds.
  Cross-compilation is not physical-platform execution acceptance.
- Seven deterministic compatibility E2Es pass; the opt-in live Codex/Pi case
  remains skipped. Those E2Es do not prove governed Agent execution.
- All 301 maintained Markdown files lint cleanly and `git diff --check` passes.

## Direction Audit and Remaining Work

This increment reuses Run/Task/Result/Artifact ownership and leaves human Result
review, execution admission and verifier authority unchanged. Checkpoint sealing
is not testing, Task completion, merge or cleanup permission. Hash validity does
not attest a malicious enrolled host.

The current local publication adapter produces non-empty sealed patch slots.
Unsupported selected output kinds or missing required outputs are rejected,
not silently omitted or replaced with invented commit/test results. Other output
producers, explicitly importing a checkpoint into a new attempt, exact-owned
cleanup, actual local grants/Runtime admission, scheduler, independent verifier,
Web workflow and later integration/autonomy increments remain required work.
No live provider, user business repository, external Git service, release or
deployment was changed by this increment.
