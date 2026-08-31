# CON-020: Governed Execution Plan Contracts

Date: 2026-08-31. Scope: the first implementation increment of ADR-0036,
covering shared contracts and deterministic plan validation only. Delivery
state is authoritative only in `docs/TASKS.md`.

## Implemented Boundary

`work/execution-plan.schema.json` defines closed decisions, source revision
pins, new/existing Task node references, dependency gates and input/output
slots, repository/base/grant/profile references, scoped output policies,
independent verification requirements, integration target pins and exact-version
proposal/approval/control envelopes. Persisted projections preserve the actual
member/Agent-Run/Discussion author. Author identity is not an input permission.

The existing generator produces TypeScript, Go and standalone Ajv validators.
`execution-validation.mjs` is the shared bounded non-mutating domain validator:
it computes a normalized plan digest and stable topological order, rejects
invalid references/duplicate producers/cycles and preserves explicit required
question blockers. This library does not execute a Task or access Git.

## Verification Performed

- Full Contracts test command: 68 Node tests passed, including 54 new graph,
  digest, scope, source-pin, input, integration and hostile-JSON checks.
- All generated Go packages compile; Go schema checks pass over 185 shared
  fixtures (40 new), and eight positive execution fixtures round-trip through
  actual generated Go types without losing content.
- Deterministic regeneration and strict TypeScript declarations pass.
- `npm run validate`: 10 schemas and 185 fixtures pass.
- `npm run build`: Server, Web and Contracts build; the existing Web large-chunk
  advisory remains visible and is not suppressed.
- Maintained Markdown lint and `git diff --check` pass.

## Implementation Review and Repairs

1. Cross-language checks exposed a regex escape accepted by JavaScript but not
   the configured Go validator. The schema now uses interoperable hexadecimal
   control-character escapes; shared Unicode, NUL and DEL cases exercise both
   engines. Neither engine is bypassed.
2. Go generation initially placed the time import after declarations when
   timestamped sources were last. The execution projection is now the leading
   source; generated Go compilation and typed round-trips cover the result.
3. Review found that source IDs alone did not freeze source revisions and a
   human-only creator field would misattribute Agent proposals. The contract
   now requires exact source revision correspondence and typed real authors.
4. Optional upstream outputs cannot satisfy mandatory downstream inputs;
   zero-effective write scopes and budgets below the required-node minimum are
   rejected rather than creating an unsatisfiable execution graph.

## Direction and Acceptance Limits

The implementation adds no replacement TaskAttempt, Result or evidence store.
Existing Bridge messages and generated legacy contracts are unchanged. Runtime
capabilities are not advertised, automatic scheduling is not enabled and no
repository is written. Source and local permission checks require the later
owning application services. These tests do not prove Server plan persistence,
human approval flows, real worktrees, verification execution, CI, browser UX,
physical-platform acceptance or final product completion. Those remain in the
complete 25-task workstream and its EX-01 through EX-14 final audit.
