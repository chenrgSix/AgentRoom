# BRG-071 Owner-Visible Cleanup Authority

Date: 2026-09-02

## Scope

This increment connects the existing exact Git worktree-retirement primitive to
production Bridge authority. It closes the missing command-line cleanup adapter;
it does not complete BRG-071, REPO-001 or RUN-018, add a public cleanup
capability, delete retained checkpoint/diagnostic storage, or claim the physical
two-Bridge handoff.

## Authority chain

Cleanup uses a separate local-only immutable `CleanupGrantSpec`. It is not an
execution operation kind, Task grant, Agent capability or Central permission.
Issuance succeeds only after the Bridge resolves the owner-selected checkpoint
through its retained local capture history and rejoins all of these facts:

1. the exact repository/binding, Run, Agent/Device, plan/node/Task, worktree
   generation and manifest pins;
2. a terminal stopped admission for that exact scope;
3. the exact possible-start process identity durably proven finished; and
4. the still-current physical repository binding.

The immutable issuance and optional digest-bound revocation live in a separate
owner-private inventory. They never enter `ListTaskGrants`, governed readiness,
the Device hello, Agent declarations or execution wire schemas.

Preview and execute nest the current grant lock, stopped-Run lock and
finished-process proof around the repository primitive's synchronous callback.
Execute additionally requires the exact preview digest and confirmation. The
checkpoint determines every path; the CLI accepts no path to delete. A
concurrent local grant revocation cannot race an admitted mutation, and signal
cancellation propagates through the command context.

## Owner commands

- `repository cleanup grant issue|list|revoke` creates, inspects or irreversibly
  revokes the cleanup-only consent. Issue requires Git and the retained local
  lifecycle; list/revoke can reopen recovery state without Git or a currently
  configured Agent and do not provision Agent identities.
- `repository cleanup preview` is read-only and exposes the exact recorded
  worktree/ref plus explicitly retained evidence paths.
- `repository cleanup execute` retires only that worktree/ref under the same
  grant/checkpoint/operation and reviewed preview digest. Exact response-loss
  replay returns the retained receipt.

Checkpoint input is an absolute bounded regular file. Symlinks, identity changes,
unknown fields, trailing documents, empty/oversized files and relative paths are
rejected before lifecycle lookup.

## Verification

Focused production-composition tests run through the owned temporary-root
runner and use actual Git, an actual isolated worktree, canonical capture and
checkpoint publication, a real child process/process-group journal and the real
admission, binding, grant and cleanup stores. They prove:

- a checkpoint without a stopped Run cannot mint cleanup consent;
- a changed checkpoint cannot mint cleanup consent;
- the exact finished and stopped Run can mint one path-free grant;
- the cleanup grant does not appear in Runtime Task grants;
- preview and confirmation remove only the Bridge-owned worktree/ref and leave
  the source checkout bytes unchanged;
- exact receipt replay is read-only; and
- revocation blocks a later replay before mutation.

Unit regressions separately cover grant expiry, current-binding revocation,
scope drift, restart persistence, callback ordering, claimed/starting/stopped
fence states, unsafe checkpoint files and strict CLI argument shapes. The
focused commands, race/vet/build results and physical no-residue snapshots will
be recorded in the final RUN-018 acceptance after the complete two-Bridge path
runs.

The current increment passed full `go test ./...`, focused cleanup/admission
race tests, `go vet ./...`, the native Bridge CLI build, Markdown lint and
`git diff --check` through run-scoped temporary roots whose printed `root` and
`cleaned` paths matched. A full admission/repository race invocation also proved
the repository package but exposed the existing verification success fixture's
one-second timeout under race instrumentation (about 1.003 seconds); that run is
not counted as passing and the unrelated test stabilization is kept as a
separate change.

## Remaining gates

The separate [owner Console and in-flight revocation](brg-071-owner-console-revocation.md)
increment now supplies the path-free local inventory surface and stop-before-
tombstone policy. BRG-071 still requires explicit Result proposal in the
physical flow and actual no-start/start evidence. REPO-001 still requires the
complete real Server/Bridge/Git lifecycle and recovery cuts. RUN-018/EXEC-003
remain open until Bridge B physically consumes the exact integrated predecessor
bytes.
