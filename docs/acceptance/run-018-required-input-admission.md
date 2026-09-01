# RUN-018 Required Input Admission Increment

Date: 2026-09-02

## Scope

This increment closes the remaining in-process Bridge admission ambiguity for a
governed implementation node with required predecessor inputs. It does not
claim the physical two-Bridge handoff, automatic Result publication,
owner-visible cleanup or completion of RUN-018/BRG-071.

## Production path

The existing production path is now covered as one joined boundary:

1. Central freezes ordered destination bindings and exposes only the exact
   authenticated destination Run/Device bytes.
2. `ExecutionInputClient` validates the manifest before networking, downloads
   each bounded patch without redirects or durable path storage, and checks the
   binding identity, digest, byte length, media type and response policy.
3. `GovernedAdmissionCoordinator.Prepare` rechecks the local grant, loads and
   freezes the exact ordered patches, and passes them to the isolated
   repository preparer before recording a possible-start claim.
4. `GovernedAdmissionCoordinator.Start` repeats the complete grant, input,
   source, preparation and Runtime profile chain before the final current
   Central authority callback.

The new combined regression proves that the same required input reaches both
repository preparation passes and that the ticket and preparer retain cloned
bytes rather than caller-owned slices. Existing negative tests continue to
reject missing, reordered, foreign, wrong-kind, wrong-length and wrong-digest
inputs before Runtime start.

## Verification

The focused command ran through the repository-owned run-scoped temporary-root
runner:

```text
node scripts/test/run-with-temp-root.mjs --cwd bridge -- go test \
  ./internal/admission -run \
  'TestGovernedCoordinator(CarriesExactRequiredInputsThroughBothStartChecks|ComposesExactPrepareAndPossibleStart)$'
```

Both tests passed. The runner printed one owned root and its matching `cleaned`
record. It used invocation-scoped Go build/module caches and did not modify a
shared user cache.

## Remaining gates

The frozen physical goal still requires the actual authenticated Central and
two real Bridge processes, downstream Result proposal, in-flight revocation,
owner-visible stopped-Run cleanup, restart/conflict cuts and three consecutive
physical no-residue runs. No task state changes to `DONE` in this increment.
