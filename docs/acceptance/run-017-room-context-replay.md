# RUN-017: Frozen Room context receipt recovery

Date: 2026-08-31. The repair follows ADR-0031's immutable Delivery authority.
Delivery state is tracked only in [the task register](../TASKS.md).

## Cause and repair

`DeliveryService.validateRoomContextConsumption` loaded the frozen bundle but
also required the Agent's current `supportsRoomContextCoverage` capability.
Bridge republishes current capabilities before recovering its durable inbox.
Removing or omitting that capability therefore rejected a valid historical
terminal event, before sequence deduplication, and closed the Device socket
with 4008. The retained event could repeat the failure on every reconnect.

Validation now depends on the existing Run and its frozen `roomContextBundle`.
Current capabilities still govern whether new Deliveries include a bundle.
Device/Agent ownership, trace, sequence, Runtime scope, result-evidence cursor,
checkpoint, raw interval, consumption disposition and coverage checks remain
enforced. Enabling a capability later cannot grant a receipt for a bundle that
was never delivered. No historical payload, event or payload hash is rewritten.

Only the Central implementation changes. No client upgrade, wire/schema change,
database migration, provider access or additional service is required.

## Regression evidence

`apps/server/test/bridge-context-replay.test.ts` uses a disposable SQLite
database, a synthetic checkpoint plus one actual raw-tail Message, authenticated
HTTP setup, and the actual Server WebSocket handlers. The checkpoint is seeded
through its repository without invoking a reducer/model. It does not substitute
a receipt-validation mock or launch a real model.

Four positive combinations cover an already-delivered or initially-unsent
terminal, with the coverage capability explicitly disabled or omitted. Each
replays the unchanged terminal over two reconnect epochs, with a Central restart
between them, and completes a new Run on the same socket. New Runs omit the
coverage bundle; the original Delivery JSON and payload hash remain identical.

Four negative cases reject a forged checkpoint on an already-completed event,
an internally consistent but wrong raw interval, future coverage, and an
undelivered bundle even after the capability is enabled. Rejection retains the
original Run state; duplicate-event handling does not bypass validation.

Before the production fix, all four positive cases failed: delivered terminals
closed with 4008 and unsent terminals did not converge. The four rejection cases
passed. After the fix all eight pass, without widening timeouts or removing an
assertion. Together with the existing scope, Delivery and event tests, all
13 focused tests pass.

## Verification

| Check | Result |
| --- | --- |
| Focused context/scope/Delivery/event suites | 13 pass |
| Full Server suite, two file workers | Two runs, each 346 pass, no failures or skips |
| Contract Node suite | 14 pass |
| Generated contracts and strict type checks | Current and pass |
| Go generated contract/validator tests | Pass |
| Schema catalog validation | 9 schemas, 133 fixtures pass |
| Server production build | Pass |
| Standalone strict type check of the new regression file | Pass |
| Deterministic cross-process E2E | 6 pass, 1 explicit live Codex/Pi skip |
| Maintained Markdown and patch whitespace | Pass |

Tests use Node 22.23.1 and the repository-pinned Go toolchain. Temporary databases
and Go build artifacts use a task-owned directory, not user runtime data or a
shared writable cache. The regression fixture closes each Server before removing
its database, including on assertion failure and restart.

After all verification processes exited, no open files were listed under the
task directory. Approximately 748 MB of disposable databases, E2E binaries and
Go build cache were removed; these can be regenerated. Small test logs remain.
No existing user data or shared cache was removed.

No live provider, real Windows/Wails installation, packaged desktop UI,
two-physical-machine acceptance, remote push, CI dispatch or Release publication
was performed. This is closure of the identified Central replay defect, not a
replacement for those separate product acceptance gates.
