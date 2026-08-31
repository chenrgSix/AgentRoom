# EXEC-006: Accepted-Result Admission Foundation Audit

Date: 2026-09-01. Scope: the accepted-result foundation separated by R13 in the
software-team design review. This audit retains the full EX-04 requirements in
EXEC-003; it does not claim governed Run delivery or two-Bridge materialization.
Delivery state remains solely in `docs/TASKS.md`.

## Audited Authority and Atomicity

Reviewed current `ExecutionInputService`, `ExecutionInputRepository`, migration
0060, the authenticated input routes, and the real HTTP/SQLite regression cases.
The earlier [accepted-result increment](exec-003-accepted-input-bindings.md)
remains historical implementation evidence; this audit does not rewrite it.

- Input freezing requires an existing Run-admission transaction and uses a
  savepoint. It resolves the whole selection before writes, binds each Run/slot
  once, replays exact content and issue time, and refuses additions after the
  destination manifest is frozen. A caught second-insert error still rolls back
  the complete selection.
- The resolver checks the current approved revision, digest, control revision,
  exact source Result/review and Artifact, current source definitions/criteria,
  destination Task/Agent/Device assignment, and bounded expiry. A selected
  accepted Result is not an independent verification or integration receipt.
- Input reads authenticate the exact destination Device, check current active
  Room/Team/ownership/assignment and Run state, and compare the complete frozen
  Run and Delivery manifests. Inner digests and scope pins are verified before
  serving exact sealed bytes. Corrupt bytes are unavailable; local storage
  paths are not returned.
- Scheduling pause prevents new input admission but does not revoke an
  unchanged already-frozen input for an in-flight Run. A changed source goal or
  criteria makes its historical accepted Result unusable for further reads.
  Historical bindings remain immutable in both cases.
- Initial canonical destination Artifact binding records supplied inputs in
  the same transaction. Failure leaves no Artifact; exact retry binds once.
  The provenance says what was supplied, not what the Agent consumed, whether
  it is correct, or whether a destination Result is accepted. Existing same-Task
  Result evidence and Artifact-relation restrictions remain intact.

The audit found a coverage gap, not a production permission defect: only the
`verified_output` unavailable branch had a direct test. Both independent gates
now have separate tests against genuinely approved plans; `integrated_commit`
uses an explicit local integration target but invokes no Git operation. Two
additional cases use real human Task commands to distinguish scheduling pause
from source goal/criteria drift. No production gate or schema was weakened.

## Validation

With Node 22.23.1 and Go 1.26.7 on macOS arm64, using task-owned temporary data
and Go cache directories:

```sh
node --import tsx --test --test-concurrency=2 \
  apps/server/test/execution-input-binding.test.ts \
  apps/server/test/migration-runner.test.ts \
  apps/server/test/hosted-agent-migration.test.ts
npm test
npm run build --workspace @convene-wire/server
npm run lint:docs
git diff --check
```

The focused command passes 36 tests: 26 input/provenance cases and 10 migration
cases. Full `npm test` passes: Server 468, Web 252, Node contracts 78, Bridge UI
56, QA evidence 45, product experience 2 and site 15, together with generated
contract consistency, type checks and Go contract tests. Server compilation,
305-file Markdown lint and whitespace checks pass. These are local regression
results, not CI, browser or live-provider acceptance.

## Remaining Full-Chain Gates

Fixtures use real source publication, human Result acceptance, SQLite and HTTP.
The destination Run is an explicitly synthetic future-admission fixture whose
temporary insertion restores the production admission guard in the same
transaction. Device identities are not running Bridges; no Agent Runtime starts.

EXEC-003 still requires independent VER-001/REPO-002 receipt resolvers and actual
authorized two-Bridge input materialization through RUN-018. BRG-071 must enforce
owner-local grants before Runtime startup. The scheduler, independent verifier,
integration, browser workflows and QA-052 through QA-055 remain required. The
existing Bridge unsupported-execution guard is unchanged.
