# QA-046: Cross-layer Bridge audit fixes

- Date: 2026-08-31
- Audit baseline: `d81579d`; decision: ADR-0031 (`a7a577a`)
- Behavioral implementation: `b3c8b75` through `7b9e7bb`
- Host: macOS 26.6.2 arm64, Node 22.23.1, Go 1.26.7
- Scope: the nine confirmed findings, their regressions and local acceptance;
  not a whole-product or physical-Windows certification

## Repair evidence

| Finding / task | Commit | Verification boundary |
| --- | --- | --- |
| Historical result versus current scope / RUN-016 | `b3c8b75` | Real Fastify, temporary SQLite and WebSockets: delivered/unsent terminal replay across two epochs, a Central restart, and successful subsequent Runs; forged current-scope claims for the old Run close with 4008 |
| New identity versus rename alias / BRG-061 | `5d7a489` | Actual Console HTTP rename A to B, create new A, save failure/retry and reload preserve two distinct IDs; ambiguous active rosters fail without rewriting identity state |
| Preset metadata editing / BRG-062 | `6f15763` | Codex/Pi complete profile and RuntimeScope equality after metadata-only edits, including missing executables; explicit credential/policy edits preserve unrelated command/environment fields |
| WebView readiness / BRG-063 | `3be1d29` | Production binder selects the platform finished-navigation event; early intent stays queued, UI dispatch is once-only, reload does not replay, shutdown rejects new activation |
| Final-page pairing consumption / BRG-064 | `977db49` | Actual page bootstrap/hashchange source in a VM consumes custom, HTTPS and loopback forms, preserves long nested private-trust links, clears URL proof and handles busy pairing; Go rejects oversized/userinfo inputs |
| Native command failure propagation / QA-045 | `08aafd7` | Real PowerShell child processes return 23/0 through all 11 extracted workflow guards; mutation tests reject missing, delayed or non-terminating guards |
| Silent prerequisite prompt / BRG-065 | `0c8a43a` | Suppressible message and negative-control native installer fixture are wired into both Windows jobs; source/syntax checks pass locally, installer execution is not claimed |
| Desktop output paths / BRG-066 | `2736738` | Real shell staging/ZIP IO covers relative, spaced and absolute paths plus existing-output rejection; PowerShell executes production ASTs for eight caller/output combinations and Go/ISCC arguments |
| macOS supported minimum / BRG-067 | `7b9e7bb` | Native arm64 bundle metadata and emitted Mach-O both report 12.0; packaging rejects simulated 11.0/26.0 binary targets before archiving |

The Delivery snapshot, not a mutable Agent publication, defines an existing
Run's scope. Ownership, sequence, trace, cancellation and evidence checks are
retained. No wire contract or database migration was needed. Existing ambiguous
identity files are not automatically reassigned: that would guess ownership.
The Console remains the sole lifecycle manager; no new service was introduced.

## Executed local verification

Go used a disposable `GOCACHE`/`TMPDIR`, the existing read-only module cache
and `GOPROXY=off`. Node tests used temporary synthetic data, with no live
Codex/Pi provider calls. The portable PowerShell archive was downloaded to the
task's temporary directory and SHA-256 verified against the official release;
it was not installed system-wide.

| Gate | Observed result |
| --- | --- |
| Final complete `npm test` | 682 pass, zero failures/cancellations/skips: Server 338, Web 220, contracts 14, Bridge UI 51, QA 42, product fixtures 2, site 15; generated contracts, TypeScript checks and Go contract tests also pass |
| `npm run validate` | 9 schemas and 133 fixtures pass |
| `npm run build` | All workspaces pass; existing large Web chunk warning remains |
| `npm run test:e2e` | 6 pass; 1 explicit live Codex/Pi skip |
| Full Bridge `go test -count=1 ./...` and `go vet ./...` | Pass |
| Identity, Console, delivery and pairing `go test -race -count=1` | Pass |
| Native macOS desktop-tag suite and vet | Pass; 4.321-second test run with the 12.0 compile/link target |
| Windows amd64 desktop build, test cross-compilation and cross-vet | Pass; executables not run on Windows |
| PowerShell workflow failure injection | 11 actual guards each tested with native exit 23 and 0 |
| PowerShell production output-path expressions | 8 caller/output combinations pass |
| Windows silent-prerequisite fixture | PowerShell parsing and source regression pass; native Inno execution pending |
| Markdown lint, JavaScript/shell syntax and patch whitespace | Pass |

The initial unconstrained aggregate run is **not** counted as a pass: it hit a
2-second existing provider-probe timeout, Web element-wait failures and the
default Go cache's sandbox permissions. With task-scoped Go cache configuration
and no parallel build, all 338 Server tests passed; the probe alone passed in
289 ms, but three Web element-wait tests still failed. The unchanged Web suite
then passed all 220 cases using two test-file workers. The Server and Web npm
commands now explicitly bound file workers to two. No assertion, scenario,
business timeout or in-test concurrency was removed or relaxed. This makes
fixture load independent of host core count; it is not a claim that timing
flakiness can never recur.

## Native macOS package

An additional package was built from committed behavioral source `7b9e7bb`
using `RELEASE_TAG=v0.0.0-audit-7b9e7bb`, `SOURCE_REF=7b9e7bb`, `GOARCH=arm64`
and an absolute output directory containing spaces. This was a local diagnostic
package, not a tagged or published Release. The package script verified the
embedded exact commit, executable `--version`, plist and ZIP creation.

`xcrun vtool -show-build` reported `LC_BUILD_VERSION`, platform `MACOS`,
`minos 12.0`, SDK 26.5. The bundle's `LSMinimumSystemVersion` was also 12.0.
The prior newer-object-versus-11.0 warnings disappeared; the dependency's
duplicate `-lobjc` warning remains non-fatal. The ZIP SHA-256 was:

```text
a4af6644287dedd8b6d60af2835682d7f29063876b09fd54d825e18689a5e630
```

The minimum follows the [Go 1.26 supported macOS floor](https://go.dev/wiki/MinimumRequirements#macos-n%C3%A9e-os-x-aka-darwin).
The installer prompt follows [Inno's SuppressibleMsgBox contract](https://jrsoftware.org/ishelp/topic_isxfunc_suppressiblemsgbox.htm).

## Explicit limits

- No Windows Wails/WebView2 cold-start, native icon, real installer upgrade,
  missing-WebView2 installation or installed protocol activation was executed
  on this Mac. Native fixture source and cross-compilation are not that evidence.
- The readiness binder uses the pinned Wails native event, but its unit tests
  inject that callback. No complete packaged Wails window or browser acceptance
  was performed in this turn. The page tests execute source in a VM, not a browser.
- No macOS 12 machine, Intel Mac package, Gatekeeper/notarization or complete
  LaunchServices activation was tested. A matching Mach-O floor is not proof
  of every behavior on the oldest supported system.
- No live provider, user configuration, credential, trust store, production
  database or deployment was modified. No remote push, CI dispatch or Release
  publication was performed.
- Broader Console decomposition and the previously noted macOS default icon
  are outside these nine repairs.

After all test/build processes completed, `lsof` found no open files under the
task directory. Approximately 1.9 GB of disposable databases, Go cache, portable
PowerShell and diagnostic binaries/archives were removed. Small verification
logs were retained; no existing user cache, data or installed application was
removed. The diagnostic artifacts can be rebuilt from the recorded source.
