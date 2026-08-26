# BRG-038 Windows Desktop Preview Acceptance

## Scope

`BRG-038` adds an unsigned Windows amd64 preview of the existing Wails desktop
Bridge. The portable ZIP contains **AgentRoom Bridge.exe**, the Bridge README,
and all three license files. The Windows shell reuses the existing authenticated
local Console, system tray, close-to-tray behavior, single-instance recovery,
Runtime discovery, Agent configuration, and manual update check.

The preview uses the system Microsoft Edge WebView2 Runtime. It has no
installer, code-signing claim, automatic updater, or Windows login-startup
integration. Settings displays that login startup is unsupported instead of
silently hiding the capability. Documentation tells users to verify the
published SHA-256 checksum and does not recommend disabling SmartScreen or
Defender.

## Automated evidence

- Commit `a1f820a` passed the complete [CI run
  33007270581](https://github.com/chenrgSix/AgentRoom/actions/runs/33007270581).
  The native `windows-latest` job ran Wails desktop tests and `go vet`, built the
  Windows GUI executable, validated its amd64 PE header and injected version,
  created the portable ZIP, and checked its safe layout and required files.
- The same CI run passed the native macOS desktop job, all Go tests and vet,
  schema validation, production workspace builds, workspace tests,
  deterministic end-to-end tests, documentation lint, patch checks, and Compose
  validation.
- A local CGO-free Windows cross-build produced a `PE32+` GUI executable for
  x86-64 and exposed the injected `v0.0.0-local` version.
- `npm run test:bridge-ui` passes all 23 embedded Console checks, including the
  explicit unsupported-login-startup projection. The full Web suite passes all
  42 tests.
- The release verifier passes a synthetic 12-asset `v0.3.0-rc.2` candidate made
  from the previous 11 verified public assets plus the current Windows desktop
  archive. It checks five CLI archives, two macOS GUI archives, one Windows GUI
  archive, `SHA256SUMS`, and three top-level license files without weakening the
  existing asset, checksum, architecture, version, path, or license checks.

## Manual acceptance boundary

No physical Windows desktop was operated during this acceptance. The evidence
does not claim a human-observed SmartScreen prompt, missing-WebView2 dialog,
tray interaction, close-to-tray transition, or second-instance focus restore.
Those are manual platform experience checks for a release candidate; the
current completion evidence covers native Windows compilation, tests, package
construction, package self-verification, and the documented preview boundary.
