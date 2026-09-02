# BRG-071 Owner Console and In-Flight Revocation

Date: 2026-09-02

## Scope

This increment exposes the existing owner-local governed authority inventory in
the loopback Console and gives an active Task grant one explicit irreversible
revocation path. It does not let Central inspect or mutate local authority, turn
the Console bearer token into a Runtime grant, delete Git data or infer a
successful revocation after an ambiguous response.

Repository binding, Task-grant, Runtime-profile, verifier-profile and cleanup
grant creation keep their reviewed exact-input CLI commands. The Console is the
owner-visible setup/state surface for those records and the sole supported
in-flight Task-grant revocation action.

## Implemented Boundary

- **受控开发** displays only the path-free inventory views already owned by
  the repository, admission and verification stores. Commands, environment
  values, credentials, selected roots and prepared-worktree paths are absent.
- A running Bridge serves a clone of the inventory inspected immediately before
  startup. It never opens a second mutable store beside the managed-core store.
  A stopped and drained Bridge may reopen the inventories under the Console's
  existing owner lease.
- Startup fails before networking when inventory inspection is malformed or
  foreign. The UI cannot hide corrupt unrelated owner state behind a usable
  grant.
- Revocation requires the exact grant ID, issuance revision `1`, immutable
  digest and an explicit confirmation. An unconfirmed, stale, changed or
  already-revoked request has no process or authority effect.
- When the Bridge is running, the Console first cancels it and waits for the
  complete managed worker to drain. Existing governed process supervision
  fences the exact child process group. Only after that boundary does the
  Console append the local grant tombstone.
- The Console then restores the previous running/stopped choice. A restart
  re-inspects the owner inventory, so the revoked grant cannot advertise
  readiness or authorize a replacement writer. If revocation commits but the
  restart fails, the response states that split outcome instead of claiming a
  rollback.
- The whole mutation is serialized against another local governed mutation and
  against Bridge startup. Inventory reads during worker drain use the last
  pre-start clone rather than racing an open store.

This is the explicit version-1 in-flight policy required by ADR-0036: local
revocation cancels the bounded Bridge execution before recording loss of future
authority. It never permits the old Run to continue capturing or a new Run to
reuse the revoked grant.

## Verification

Focused Go Console regression proves:

- the HTTP surface requires the local Console bearer token;
- the response contains the exact safe grant identity and omits both a local
  path and Device token;
- missing confirmation does not stop the Bridge or enter the mutation;
- confirmed revocation observes the stopped worker before the tombstone
  callback and restarts exactly once; and
- the embedded page contains the owner surface.

The pure UI regression proves presentation ignores unexpected path/command
properties, constructs only text-safe inventory rows and binds revocation to the
exact revision/digest. The complete embedded UI suite remains green.

Commands:

```text
node scripts/test/run-with-temp-root.mjs --cwd bridge -- go test ./internal/console
npm run test:bridge-ui
```

BRG-071 remains open until RUN-018 records the positive physical Runtime start,
an actual pre-start revocation/no-process cut and the complete two-Bridge
Result/input chain. REPO-001 remains independently gated on physical
worktree/capture/recovery/cleanup evidence.
