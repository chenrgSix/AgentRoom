# ADR-0039: Keep repositories client-owned and remote evidence optional

- Status: Accepted
- Date: 2026-09-03
- Supersedes: the remote-forge roadmap assumptions in ADR-0036 and ADR-0038;
  preserves their delivered contracts, migrations and evidence history

## Context

ConveneWire's governed software-team path has proved local Plan-owned
execution, deterministic scheduling, independently retained proof, exact
evidence adoption and owner-local repository integration. The Repository and
Git lifecycle is physically performed by a Client/Bridge under an Owner's local
binding and grant. Central coordinates that work but does not possess the
checkout, shell or machine authority.

REPO-003, REPO-005 and SEC-014 later added an authenticated Remote Evidence
producer inside the Server process. Those bounded tasks are complete and useful
when explicitly configured. Treating that adapter as a required next step,
however, would blur two separate products: the core control plane and an
optional external-evidence connector. It would also invite Central to grow
Git-host credentials, repository network operations and forge mutation
authority that belong with the machine Owner.

The product therefore needs an explicit classification that preserves delivered
work while preventing optional Remote Forge breadth from controlling Core
completion.

## Decision

### Governed Software-Team Execution Core

The Core ownership rule is:

> Central governs; Client executes; Owner controls the machine; Repository and
> Git remain client-owned.

Central owns only the collaboration and control-plane facts required to answer
why an operation may happen:

- approved Plan topology and revisions;
- scheduler mode, readiness, dispatch and bounded recovery decisions;
- human and delegated authorization records;
- opaque repository operation requests and immutable receipts;
- SourceEvidence, GateProof, EvidenceAdoption and reuse/carry-forward facts;
  and
- safe path-free progress, conflict and attention projections.

Central does not own or receive authority over a repository path, Git remote,
Git credential, SSH key, fetch, pull, push, worktree, ref mutation or Git
command execution. A Central approval is necessary control-plane authority; it
is never sufficient machine authority.

The Client/Bridge and its human Owner own:

- selection and registration of the local repository and allowed root;
- repository paths, remote configuration and all Git/SSH credentials;
- fixed Git executable and argument construction;
- fetch/pull/push and any other repository network operation;
- worktree, branch, index and local ref lifecycle;
- Runtime and verifier commands and their local environment; and
- final local admission, cancellation, cleanup and receipt production.

The effective operation remains the intersection of an exact Central request
and a current Owner-local binding/grant. Neither side can silently substitute
for the other.

### Optional Remote Evidence Extensions

The existing RemoteProvider, remote commit/CI observation and remote input
attestation implementation is classified as an Optional Remote Evidence
Extension. REPO-003, REPO-005 and SEC-014 remain `DONE`; their schemas,
migrations, services, tests and immutable acceptance records remain supported
and are not rolled back or deleted.

The extension may import and authenticate external evidence when a Server
operator explicitly installs its runtime credential resolver and an authorized
binding/operation exists. That extension-local adapter authority is not part of
the Central Core domain and does not grant repository mutation, Git command or
Owner-machine authority. Existing provider metadata and receipts remain
evidence records, not a Git remote configuration owned by Central.

Default installation has no Remote Provider credential and performs no active
external provider access. Absence, disablement or non-use of the extension must
not reduce Core readiness, Core completion or the validity of local evidence.

No new GitHub/GitLab adapter, PR lifecycle, webhook, push, remote merge or
provider-credential Web UI work is on the active roadmap. Such work requires a
new stable task and an explicit accepted product decision covering ownership,
credential location, data egress, failure recovery and default-off behavior.

### Roadmap

The Core continuation order is:

1. `EXEC-005` Plan supersession, evidence carry-forward and bounded replanning;
2. `DISC-011` focused participant selection;
3. `DISC-012` opt-in read-only quorum sealing and late evidence;
4. `QA-054` bounded-autonomy acceptance; and
5. `QA-055` final Core implementation audit.

Optional Remote Evidence regressions continue to run because retained code must
remain safe. They are compatibility/security evidence, not Core exit gates and
do not create a reason to add more Remote Forge scope.

## Alternatives

### Delete the delivered Remote Evidence implementation

Rejected. Its immutable evidence, migrations, tests and deployed compatibility
are valid. Product prioritization does not justify history rewriting.

### Keep Remote Forge on the Core roadmap

Rejected. It would make external provider availability and credential handling
appear necessary to a local owner-governed execution system.

### Let Central own repository credentials for convenience

Rejected. This combines collaboration authority with machine and repository
authority, expands compromise impact and weakens the Owner's final local fence.

### Treat every external provider as a Client/Bridge implementation detail

Deferred rather than required. A later demand may define a Client-owned
connector, but this decision does not migrate or redesign the retained optional
Server extension.

## Consequences

Core product completion can proceed without a provider account, public network,
remote commit observation or CI attestation. Local Bridge-produced candidate,
verification, integration and exact evidence adoption remain the canonical Core
path.

Documentation must display Core and Optional Extension tasks separately.
Historical dependencies and accepted evidence remain truthful, including tests
where an already-complete acceptance happened to exercise both. Future Core
tasks must not acquire a new dependency on Remote Evidence work without a later
accepted decision.

The retained optional adapter still needs regression and security maintenance.
`SEC-014` remains applicable whenever it is enabled, and its default-off state
is not permission to weaken egress, credential or replay controls.

## Compatibility and Security

This decision performs no schema migration, API removal, feature rollback,
credential movement or behavior change. Existing optional records and endpoints
remain compatible. Default installations remain credential-free and inactive
for Remote Provider access.

Central continues to store only the safe control-plane facts already accepted.
Local paths, Git/SSH credentials, repository commands and worktree details stay
on the Client/Bridge. Any future connector must prove that its placement does
not bypass this ownership rule.

## Verification

Acceptance requires:

- a new stable governance task in `docs/TASKS.md`;
- an explicit Core continuation chain and Optional Extension section;
- aligned Execution, Repository, Security, Contracts, Web and Testing module
  descriptions;
- preserved `DONE` state and acceptance links for REPO-003, REPO-005 and
  SEC-014;
- no implementation, migration or generated-contract deletion; and
- Markdown lint, task-register inspection and whitespace checks.
