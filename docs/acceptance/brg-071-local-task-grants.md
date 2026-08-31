# BRG-071 Exact Local Task Consent Increment

Date: 2026-09-01. Scope: explicit owner CLI issuance, strict local specification,
immutable/revocable consent, and current-manifest prerequisite checks. Delivery
status remains only in TASKS; this does not complete BRG-071 or enable a Runtime.

## Implemented Behavior

- `repository grant issue/list/revoke` shares the existing Bridge owner lock,
  exact paired-owner namespace and local repository registration. Issuance
  requires confirmation, a bounded regular JSON file, current local credential
  and one existing configured Agent. Read-only identity lookup never provisions
  or rewrites identities and rejects ambiguous active aliases.
- Consent binds the exact physical registration, repository/base, compiled
  plan/node/Room/Task, definition/criteria revisions, Agent, profile fingerprints,
  scope, operations and expiry. It is not permission inferred from pairing or
  Agent persona. No path, command, environment or token is emitted in inventory.
- Canonical digest identifies the immutable local issuance record. Normalization
  clones caller arrays, rejects duplicates/null arrays and sorts set-like values.
  Exact replay/reopen preserves bytes/time; changed consent conflicts. A separate
  revision-2 tombstone requires the reviewed issuance digest and cannot be undone.
- Revocation/list survive missing Git/source and expired credentials. Cross-owner
  namespaces, replaced directories, malformed records and revoked bindings cannot
  admit work. No cleanup, source checkout change, fetch or Runtime start occurs.
- `CheckTaskGrant` validates manifest/input digests, exact frozen identity/pins,
  operation, expiry, physical binding and scope intersection. Narrower allowed
  prefixes remain possible; prefix collisions, dropped overlapping denials,
  preventive-policy downgrade and read-only-to-write escalation fail closed.

## Review Resolutions and Remaining Boundaries

This increment reuses generated wire policy/summary/manifest types. The local
specification adds owner consent pins, not a second Task/Run authority or a
public creation API. Issuance follows plan compilation, so new child Task IDs
need not exist before approval. The plan references a required grant identity;
only a subsequent explicit local action creates consent for that compiled Task.

Profile pins do not prove installation, safety or enforced sandboxing. The
production adapter must resolve those exact local profiles, validate current
Central/Agent authority and the existing Run/generation fence, and recheck
consent before each effect. A positive prerequisite check cannot authorize an
arbitrary shell, integration, push or Runtime invocation. Current delivery and
RuntimeExecutor still reject governed manifests before starting anything.

During focused testing two negative fixtures initially made no actual change:
the replacement plan digest equaled its seed and the omitted-field replacement
did not match the final JSON property. Both fixtures were corrected; they now
exercise real drift/omission and pass. These were test defects, not silently
accepted exceptions to the authority checks.

## Physical Sandbox Investigation — Not Acceptance

The installed macOS `codex-cli 0.151.0-alpha.7.2` was checked against official
[permission documentation](https://learn.chatgpt.com/docs/permissions) and
[App Server documentation](https://learn.chatgpt.com/docs/app-server), then its
locally generated experimental protocol schema. This followed OpenAI Docs and
did not substitute newer documented fields for the installed protocol.

A temporary app-server probe initialized with `experimentalApi: true` and used
`command/exec` only; it created no model turn. Its generated named profile had
minimal read access, workspace-root write and network disabled. A second variant
also explicitly denied `:root`, `:tmpdir` and `:slash_tmp`. The fixture created
an ordinary random canary beside, not inside, its selected workspace.

| Observation on this host/version | Result |
| --- | --- |
| Initial probe inside the outer tool sandbox | App-server could not initialize its normal local SQLite state; no inner-policy conclusion |
| Same scoped probe allowed to initialize local app-server state | Initialization succeeded |
| Unknown named permission profile | Rejected with JSON-RPC invalid-profile error |
| Legacy `readOnly` policy, outside-file write | Nonzero exit with permission denial |
| Named profile, inside-file write | Succeeded |
| Named profile, outside canary read and outside-file write | Both succeeded, including the explicit-deny variant |
| `config/read` for the explicit-deny profile | Returned the intended exact closed definition |
| Probe without inherited `CODEX_SANDBOX` | Outside read and write still succeeded |
| Canonical private canary under disjoint `/private/var/tmp` root | Outside read and write still succeeded |

The named-profile path therefore has no successful boundary evidence here. Its
exact cause is unresolved; this does not establish a general failure of every
Codex execution path. The probe is not Agent Runtime, network isolation, native
Windows/Linux or production admission acceptance. No failed probe is converted
to a supported capability. A new Bridge filesystem probe preserves this result
as a fail-closed admission prerequisite, not a registration. See its separate
[increment evidence](brg-071-codex-filesystem-probe.md). BRG-071 retains enforced
Runtime/profile work, actual no-start/escape tests, owner UI, in-flight
cancellation and stopped-Run cleanup.

## Validation Record

- Full `go test -json ./...`: 374 passing top-level tests across all 24 Bridge
  packages. Five existing helper entry points skip without caller flags; the
  operations package has no tests. No test failure is hidden in the JSON log.
- Final focused tests cover 15 new top-level grant/CLI/identity cases and their
  nested matrices: both Git object formats, canonical retry/reopen, concurrency,
  24 manifest-drift cases, invalid owner inputs, full-record size, corruption,
  namespace/binding replacement, prefix intersection, exact/offline revocation,
  no identity provisioning, live owner-lock exclusion and strict file handling.
- Final focused race tests pass for repository, identity and production CLI.
  Full `go vet ./...`, native CLI build/version and Windows amd64
  repository/CLI plus Linux amd64 CLI cross-builds pass. Cross-builds do not
  establish native ACL/sandbox behavior.
- `npm run test:e2e`: seven deterministic compatibility scenarios pass; the
  explicit live-provider scenario is skipped. No provider or model turn was
  invoked. The physical sandbox probe above used command execution only.
- `git diff --check` and Markdown lint pass for 309 maintained files.

This increment is local consent and rejection evidence, not actual governed
Runtime, independent verifier, Browser/Console UI, cleanup integration or
two-machine acceptance. No external repository, PR, release or deployment was
changed. BRG-071 remains `ACTIVE` and all later gates retain their scope.
