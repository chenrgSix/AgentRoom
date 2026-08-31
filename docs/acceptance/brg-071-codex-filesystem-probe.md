# BRG-071 Codex Filesystem Boundary Probe Increment

Date: 2026-09-01. Scope: a fail-closed Bridge primitive that interrogates one
installed Codex App Server permission profile and physically tests its local
filesystem behavior. Delivery status remains only in TASKS; this increment does
not complete BRG-071, register a Runtime profile or enable governed execution.

## Implemented Behavior

- `ProbeCodexFilesystemPermissionProfile` is currently native-macOS-only. It
  resolves and hashes the exact executable, starts a separately managed App
  Server process group, initializes the experimental protocol, and requires one
  exact allowed named profile from `permissionProfile/list`.
- `config/read` must return a closed profile with `:root`, `:tmpdir` and
  `:slash_tmp` denied, `:minimal` read-only, only the current `.` workspace root
  writable, and network declared disabled. Inheritance, extra roots, unknown
  fields and any broader network setting are rejected.
- The child receives only an explicit safe local environment allowlist. Secret
  variables, duplicate names and inherited sandbox markers are rejected. The
  executable entry must be named `codex`, with exactly one App Server subcommand
  and one standard-I/O transport argument; known sandbox-bypass flags fail.
- A unique workspace target must be writable. A random canary and second target
  in separate Bridge-owned private scratch must be unreadable and unwritable;
  the canary must remain byte-identical and the denied target absent. Workspace
  and scratch must be canonical, disjoint, non-symlink directories.
- Responses are size-bounded JSON lines. Malformed output, protocol errors,
  wrong IDs, duplicate/widened profiles, timeouts, process failure or cleanup
  failure all fail closed. The process group and exact generated probe paths are
  cleaned without traversing an owner repository.

The returned diagnostic result contains executable/profile digests, timestamp
and platform, but no command, environment, path or canary. Its type and contract
explicitly say filesystem probe rather than permission evidence: it is not a
reusable authorization and must be rerun against the exact future governed
workspace immediately before startup.

## Review Resolution

The first design treated a strict `network.enabled: false` definition as if it
were complete permission-profile evidence. Review separated declaration from
physical enforcement. This increment verifies only filesystem behavior. A
native loopback/network escape fixture is still required before any Runtime
profile can be accepted, along with command/environment/profile binding,
resource limits, current grant/Run authority and the existing no-duplicate-start
fence. Windows and Linux remain unsupported rather than inferred from a macOS
result.

The probe intentionally does not execute a model turn, repository command or
owner source change. Its simulated positive fixture tests the detector logic;
it is not evidence that the installed Codex executable passes.

## Current Physical Host Result — Capability Remains Closed

The installed macOS `codex-cli 0.151.0-alpha.7.2` was checked using the official
[permission documentation](https://learn.chatgpt.com/docs/permissions),
[App Server documentation](https://learn.chatgpt.com/docs/app-server), and its
locally generated protocol schema. `config/read` returned the intended closed
named profile. The same outside read and write escape remained after removing
the inherited `CODEX_SANDBOX` marker and moving the canary to a canonical,
private, disjoint root under `/private/var/tmp`.

Therefore this host/version has no positive named-profile filesystem evidence.
The exact cause remains unresolved, and the result does not generalize to every
Codex path or version. Bridge does not register the profile, advertise governed
execution or weaken the existing Runtime no-start fence.

## Validation Record

- Focused tests cover simulated success, read escape, write escape, missing and
  duplicate/broadened profiles, malformed protocol output, unsafe
  commands/environments, invalid timeouts, path overlap/symlinks and closed
  profile parsing.
- The positive fixture performs actual temporary file operations, while every
  negative fixture verifies that generated inside/outside probe artifacts are
  removed. No fixture touches an owner repository or invokes a provider.
- The exact new focused and race suites pass. A broader race-only run exposed an
  existing 150 ms Codex deadline fixture that loses its pre-timeout context
  event under race instrumentation; it reproduced five times while the complete
  ordinary Runtime suite passes. That timing fixture is not treated as a probe
  failure or hidden as a passing full-race gate.
- All 25 default Bridge package paths pass (`operations` has no test files), as
  do `go vet ./...`, native CLI build/version, Windows amd64 and Linux amd64 CLI
  cross-builds. Cross-builds do not prove native sandbox behavior.
- Compatibility E2E passes all seven deterministic scenarios; the explicit live
  provider scenario is skipped. Markdown lint passes 310 maintained files and
  `git diff --check` is clean.

BRG-071 remains `ACTIVE`. Remaining work includes actual profile registration
and owner setup, physical network and non-macOS fixtures, just-in-time production
admission, in-flight revocation, stopped-Run cleanup and real no-start/start
evidence through RUN-018.
