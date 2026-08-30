# QA-043: Bridge audit repairs

- Date: 2026-08-31
- Baseline: `c371395`; reported source: `37dda4f`
- Scope: BRG-054, BRG-055 and BRG-056 under ADR-0029
- Implementation commits: `32025c2`, `6241318`, `92c7362`
- Result: local regression/build acceptance passed; native and dependency
  limitations remain explicit below

## Findings and repairs

All three reported issues were present in the current source.

### Durable outcome versus delivery

`RuntimeExecutor.Execute` now consults the inbox after an Adapter error. A
durably completed, failed, canceled, input-required or unknown boundary remains
authoritative; a failed send returns its original error without another event,
new sequence or altered Runtime observation. Recovery and duplicate delivery
replay the original record without invoking the Adapter again. An unfinished
working/output failure still follows the conservative unknown-outcome rule.
Cancellation fences remain until successful terminal replay.

The regression first failed for all five terminal/recoverable boundaries on
the original code. It now verifies exact persisted bytes, original errors,
observations, clarification/session fields, repeated recovery, duplicate
delivery, one invocation and cancellation-fence retention.

### Ordinary editing versus Runtime conversion

The Console resolves the stable Agent identity and saved kind before building
an edit. Generic CLI editing copies its complete saved profile and changes only
name, role and explicit Workspace/alias fields. Its command, arguments, adapter,
preset version, environment policy and output protocol remain unchanged.
Cross-kind edits return 409; attempts to inject readonly Runtime fields return
400. Same-kind Codex/Pi editing and creation remain available.

The real editor selects Generic CLI, locks Runtime selection and the command,
hides preset discovery/preflight and explains that conversion is not an edit.
The regressions compare complete persisted configuration, stable identity after
reload and unchanged RuntimeScope for metadata edits. Explicit Workspace
changes alone change scope. Fifteen negative cases cover conversion, readonly
field injection and invalid local settings; a late discovery response cannot
overwrite a subsequently opened Generic editor.

An opt-in `TestGenericEditorBrowserFixture` served the actual embedded UI and
Console API with temporary synthetic credentials and inert Runtime dependencies.
At 1280x720, rename, save, reload and reopen retained Generic CLI, readonly
Runtime/command and the sibling Pi Agent. Add-Agent still allowed Codex/Pi.
The modal had no horizontal overflow; browser warning/error logs were empty.
On shutdown the fixture compared the complete persisted Generic configuration
and stable identity, not just visible text. The test passed. Its listener and
the task-owned browser tab were closed afterwards.

### Desktop activation versus Console ownership

Desktop arbitration now precedes Console construction and Bridge startup.
Windows retains the released mutex name but uses Wails' public window class
and interceptor hooks, avoiding beta.12's `FindWindowW` lookup of a
message-only window. A secondary process never opens Console state. It waits
up to five seconds for the primary window, sends once with a bounded timeout,
verifies the target user and checks acknowledgement. The instance lease
outlives Console drain/close.

Received activations are bounded and validated before entering a main-thread
queue; a wake cannot erase a pending pairing link. UI callbacks run outside
the queue mutex to allow native reentry. Pairing proof is not logged or saved.
Explicit pairing flags, custom URI and HTTPS forms are distinguished, and
contract-length private-CA links fit the bounded 16/32/48-KiB link/plaintext/
encoded limits. New executables can locate the previous Windows message-only
window for custom-URI activation; an HTTPS link to that older receiver fails
explicitly instead of silently becoming a wake.

Windows-specific regression source exercises native mutex and window APIs in
separate processes, delayed window readiness, pairing then wake, legacy window
lookup, failure classification, malformed memory/payload boundaries and owner
release. The existing Windows CI job already runs desktop-tag tests; source
and cross-compilation are not evidence of their execution on Windows.

## Executed verification

Commands used Node 22 and Go 1.26.7 with task-scoped temporary test/build data.

| Gate | Result |
| --- | --- |
| Full Bridge `go test ./...` | Pass |
| Full Bridge `go test -race ./...` | Pass |
| Full Bridge `go vet ./...` | Pass |
| Focused delivery and Console tests/race/vet | Pass |
| `npm test` | 666 pass, zero failures |
| Embedded Bridge UI subset | 48 pass |
| `npm run test:e2e` | 6 pass; live Codex/Pi scenario explicitly skipped |
| `npm run build` | Pass; existing large Web chunk warning |
| `npm run validate` | 9 schemas and 133 fixtures pass |
| Native macOS desktop-tag tests/race/vet/build | Pass; local SDK deployment-target linker warnings |
| Windows amd64 desktop test cross-compilation and cross-vet | Pass; binary not executed on Windows |
| Browser Generic edit and persisted-config fixture | Pass |
| Markdown lint and patch whitespace | Pass |

The macOS linker warns that local SDK objects target macOS 26 while the link
target is 11.0. Tests and the native build exit successfully; this is not
acceptance on older physical macOS versions.

The Windows checks were `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c
-tags desktop ./cmd/convenewire-bridge-desktop` with a task-scoped output file,
and `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go vet -tags desktop
./cmd/convenewire-bridge-desktop`. The native Windows test functions are present
in the compiled test binary but were not run on this macOS host.

After validation, no open files remained under the task's temporary root.
The approximately 1.2-GB disposable build/module caches, synthetic test data,
logs and generated macOS/Windows binaries were removed. They are reproducible;
no pre-existing cache directory or user installation was removed.

## Explicit limits

- No native Windows execution or packaged installer/protocol activation was
  performed in this task. No hosted CI run or Release was dispatched.
- macOS retains Wails beta.12: its instance lock is acquired in `New`, before
  the native notification listener starts in `Run`. Notifications in that
  intervening startup window still lack acknowledgement and can be lost.
  The application queue preserves only events Wails actually delivers. This
  known dependency limitation is tracked separately as BRG-057.
- No live provider, production database, user Bridge configuration, installer,
  credential, trust store or central deployment was changed.
- Broad `console/server.go` decomposition remains outside these behavioral
  repairs; the Console is still the single Bridge lifecycle manager.
