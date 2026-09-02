# REPO-003 Remote Evidence Adoption Goal

Status: frozen on 2026-09-02 and accepted on 2026-09-03. `docs/TASKS.md`
remains the sole delivery-state register. ADR-0038 and the accepted
CON-023/EXEC-009 contracts remain the evidence authority; this delivery extends
their remote producers without reinterpreting local evidence or reuse
semantics.

## Goal

Admit one exact remote repository commit and its configured CI observations as
independent, immutable evidence, then explicitly adopt that evidence for one
approved plan revision/node and deliver its sealed output bytes through the
existing dependency graph:

```text
owner-configured ProviderBinding + runtime credential
  -> authenticated exact commit observation (lookup before create/retry)
  -> bounded canonical Git bundle import and exact commit/tree validation
  -> sealed commit-bundle Artifact + derived patch Artifact
  -> repository_commit SourceEvidence(remote_observation)
  -> authenticated exact CI observation(s)
  -> ci_observation_receipt GateProofRef(s)
  -> explicit revision-local EvidenceAdoption(verified_output)
  -> adoption-first dependency/input reader
  -> exact downstream sealed patch bytes
```

The remote producer has no Agent Result, local Run, local checkpoint or Device
identity. None may be fabricated as a compatibility anchor. A provider
observation records provenance; only a separate, current-authority adoption can
release a graph gate.

## Ownership And Contracts

- `RemoteProviderBinding` is immutable owner-configured metadata plus an
  append-only revocation. It pins Team, logical repository, fixed provider
  origin, provider repository identity and closed CI check/profile mappings.
- Provider credentials are resolved at request time through a Central-local
  secret resolver keyed by binding ID. Tokens are never stored in SQLite,
  contracts, Artifacts, logs, errors or receipts.
- `RemoteCommitObservation` pins one idempotent operation, binding/repository,
  exact base/candidate commit and candidate tree, Git object format, optional
  pull-request provenance, provider observation identity/digest and imported
  Artifact identities. It is immutable and is not an adoption.
- The provider-supplied bundle must be a complete bounded Git bundle containing
  the exact base and candidate closure. Central validates it in an owned
  temporary repository using fixed Git arguments, verifies object format,
  commit/tree and base ancestry, then derives the canonical binary patch used
  by existing Bridge input preparation.
- The bundle and patch are retained as sealed canonical Artifact content. Their
  bytes, lengths and SHA-256 digests are verified before SourceEvidence is
  retained. No remote URL, local path or credential enters evidence JSON.
- `RemoteCIObservationReceipt` pins one configured check key/profile,
  candidate commit/tree, provider attempt, terminal outcome and authenticated
  provider observation. Only `passed` can yield a
  `ci_observation_receipt` proof reference.
- `RemoteEvidenceAdoptionService` is the sole remote adoption writer. It
  rechecks current binding, plan approval/control, node/Task/repository,
  required verification mappings, exact source/proof digests and absence of a
  conflicting local attempt before retaining one revision-local adoption.
- Dependency and frozen-input readers select by adoption/source identity. A
  companion Result remains optional and is present only for actual
  `task_result` evidence.

All new wire unions remain closed and digest-bound. Stable operation replay
returns byte-identical facts; the same operation ID with another actor,
binding, repository, commit, check, plan, node or payload conflicts.

## Provider Protocol And Retry Rules

The first adapter is provider-neutral HTTP version 1. The binding owns one
normalized fixed origin; callers cannot supply a URL. Production origins must
use HTTPS. Loopback HTTP is accepted only for deterministic local acceptance.
Redirects are rejected.

Commit and CI observation effects use authenticated exact-operation lookup
before creation:

1. `GET` the fixed operation resource using the binding credential.
2. If it exists, require every identity field and digest to match.
3. Only an authenticated `404` permits one idempotent `POST` with the exact
   operation ID.
4. A timeout, reset, malformed response or other ambiguous outcome is retained
   as `outcome_unknown`. A later explicit retry starts again at `GET`; it never
   blindly repeats `POST`.
5. Multiple, foreign, stale or substituted observations fail closed.

Bundle bytes are fetched only from the fixed observation endpoint derived from
the authenticated observation ID. Responses have closed content types and
bounded JSON/body sizes. Provider callback payloads are not a second authority
path in this slice; unauthenticated or unsolicited callbacks are rejected.

## Persistence And Crash Cuts

Migration is additive and does not weaken or rebuild local evidence tables:

1. add immutable provider bindings/revocations, remote operation journals,
   commit observations and CI receipt tables;
2. add exact remote Artifact import authority so canonical content can be
   retained without a fake local publication/Run;
3. permit a remote-origin repository source and its proof/adoption only through
   those exact retained records;
4. extend the adoption-authoritative materialization and input projections with
   nullable companion-Result fields plus required source/adoption pins;
5. preserve all legacy local triggers, projections and byte behavior.

An operation intent is durable before external I/O. Authenticated observation
metadata is durable before bundle import. Temporary repositories and partial
uploads are owned by the exact operation and removed in `finally`, including
spawn error, assertion, timeout and cancellation. If Central stops after a
provider effect, the next retry uses lookup. If it stops after bytes are sealed,
deterministic Artifact/content identities allow exact reconciliation without
refetching or duplicating evidence.

No service scans or glob-deletes a provider cache or system temporary folder.
Only paths created and held by the current operation may be removed.

## Admission Rules

The first bounded remote node is an approved/running implementation node with
an exact logical repository/base, declared patch output and configured required
verification profiles. It has no current DispatchIntent/Run and no unresolved
inbound input. This restriction prevents remote observation from replacing a
started local writer or claiming inputs that the provider never proved.

Adoption requires:

- current Room/Team owner authority and exact approved plan/control revision;
- an active, unrevoked binding for the node's logical repository;
- exact source repository/object-format/base/candidate/tree and sealed Artifact
  pins;
- one passed, current, distinct CI receipt for every required verification
  profile through the binding's closed check mapping;
- no failed, canceled, timed-out, unknown, foreign or stale receipt in place of
  a required pass;
- a freshly computed node execution digest and empty resolved input-set digest;
- an explicit adoption operation; observation alone never auto-adopts.

The existing EvidenceReuseContract remains a comparison fact only. REPO-003
may retain its companion for the remote adoption, but it grants no carry-forward
authority. Future EXEC-005 must compare `nodeReuseContractDigest` and
`reuseInputEvidenceDigest`; it must never compare adoption-specific
`contractDigest`, `adoptionDigest`, plan identity or execution digests as reuse
equivalence.

## Required Evidence

Completion requires physical evidence for all of the following:

1. valid authenticated commit lookup/create/import seals exact bundle and patch
   bytes, retains one remote SourceEvidence and survives restart/replay;
2. response loss after provider creation is recovered by lookup with exactly
   one provider effect; a changed replay conflicts;
3. wrong/missing credential, redirect, foreign repository, moved base, wrong
   commit/tree/object format, malformed/oversized/truncated bundle and Git spawn
   failure retain no usable source/adoption;
4. authenticated passed CI receipts bind the exact configured check, attempt,
   commit/tree/profile; failed/timeout/unknown/stale/foreign/substituted or
   duplicate checks cannot satisfy adoption;
5. explicit adoption retains one exact `verified_output` projection without a
   Result, while SQL update/delete and operation substitution fail;
6. adoption-first dependency/input readers schedule the downstream Run and its
   authenticated Bridge endpoint returns the exact derived patch bytes;
7. a remote source/receipt without adoption, a legacy-only projection, or a
   deleted adoption fails closed after restart;
8. concurrent exact operations converge, distinct bindings do not interfere,
   and revocation races prevent new I/O/adoption without rewriting history;
9. migration/reopen/backup compatibility, contract generation, full Server and
   workspace regressions, deterministic E2E, Bridge tests, build and docs gates
   pass;
10. real loopback HTTP fault injection covers success, authenticated 404,
    response loss, timeout, malformed response and replay; physical SQLite,
    Git, Artifact and provider-call counts are inspected;
11. three isolated temporary-lifecycle runs add no `agentroom-*`,
    `agent-room-*`, `convenewire-*` or `convene-wire-*` directory and every
    operation-owned Git/import root is physically absent afterward.

## Delivery Evidence

The accepted implementation is split into single-purpose commits: `3c81444`
freezes this goal, `d937c84` closes the remote wire contracts, `269c04d`
retains and revokes provider bindings, `aeaa665` journals authenticated remote
observations, and `5781e0a` imports/adopts evidence and cuts dependency readers
over. Compatibility repairs `6b1ed95` and `8268c36` preserve the local reader
shape and omit an absent Go `sourceAuthority` instead of serializing `null`.

Migrations 0077 through 0080 retain immutable provider bindings, remote
operation journals, commit/CI observations, remote evidence adoptions and the
adoption-authoritative input projection. The HTTP surface is deliberately
small:

- `POST /api/teams/:teamId/remote-provider-bindings`;
- `POST /api/remote-provider-bindings/:bindingId/revocations`;
- `POST /api/execution-plans/:planId/remote-commit-observations`;
- `POST /api/execution-plans/:planId/remote-ci-observations`;
- `POST /api/execution-plans/:planId/remote-evidence-adoptions`.

The physical Server acceptance uses a real loopback provider and real Git
repositories. It proves authenticated GET-before-POST, one external effect
under concurrent exact requests, restart/replay without new provider I/O,
response-loss recovery, timeout/redirect/body bounds, missing credentials,
revocation, changed-operation conflict, exact repository/base/commit/tree and
SHA-1/SHA-256 object-format checks. Malformed/truncated bundles and Git spawn
failure retain neither usable evidence nor owned temporary roots.

Only a configured terminal CI pass creates a proof. Failed, timed-out,
outcome-unknown, foreign, stale and duplicate checks cannot satisfy the exact
profile set. Explicit adoption then creates one Result-free `verified_output`;
without that adoption the graph remains blocked. With it, the real scheduler
creates the downstream Run and the authenticated Bridge input endpoint returns
the byte-exact canonical binary patch derived from the imported commit.

The final verification record is:

- `npm run validate` — 13 schemas and 258 fixtures pass;
- `npm test --workspace @convene-wire/contracts` — 90 Node contract tests,
  deterministic generated TypeScript/Go checks and Go tests pass;
- `npm test --workspace @convene-wire/server` — 544 tests pass, including the
  physical SQLite/HTTP/Git/Artifact/scheduler/Bridge-reader cases;
- `npm run test:bridge` — every Go Bridge package passes and its owned root is
  physically removed;
- `npm run build` — Server, Web and generated-contract builds pass;
- `npm run test:e2e` — eight deterministic cases pass and the opt-in live-model
  case is skipped; the owned E2E root is physically removed;
- `npm run test:temp-lifecycle` — three isolated rounds each pass all 24 tests.
  For all four forbidden prefixes, every round records `before=0` and
  `after=0`; the isolated base also contains zero entries after each round.

`npm test` also passes the complete Server, Web, contracts, Bridge UI, QA
evidence, product-experience, site and temporary-lifecycle workspace regression;
its outer owned root reports a matching physical cleanup. `npm run lint:docs`
reports zero issues. Passing tests are not the sole criterion: the tests inspect
retained row/effect counts, exact Git objects and sealed bytes, and the
lifecycle acceptance asserts the physical absence of operation and run roots.

## Explicit Non-goals

This goal does not push to a remote, create/update/merge a pull request, accept
webhooks, execute a live public provider, persist provider credentials, mutate
a shared Git ref, replace local verification/integration, implement scheduler
modes or cross-sweep fairness, perform automatic retry, supersede a plan, carry
evidence to another revision, generalize to arbitrary evidence kinds, remove
legacy local tables, or claim multiple physical computers. Optional PR identity
is immutable provenance attached to the observed commit, not review or merge
authority.
