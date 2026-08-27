# BRG-039 Windows Installer Acceptance

## Scope

`BRG-039` adds an unsigned, per-user Inno Setup installer for the Windows amd64
Desktop Bridge while retaining the portable ZIP. The installer:

- installs by default under
  `%LOCALAPPDATA%\Programs\AgentRoom Bridge` without requesting elevation;
- uses one stable application ID for in-place upgrades;
- creates a Start menu shortcut, offers an unchecked desktop shortcut, and
  registers a current-user uninstaller in Windows Apps;
- installs the executable, README, and all three license files;
- leaves `%APPDATA%\agentroom` owner configuration outside installer ownership;
- asks Restart Manager to close a running Bridge for replacement without
  automatically relaunching it; and
- detects WebView2 through Microsoft's documented machine and current-user
  Evergreen Runtime registry keys. If no Runtime is detected, it warns the
  user and offers an unchecked link to Microsoft's official download page. The
  installer contains no WebView2 downloader or Runtime executable.

The installer wizard is currently English. The installed Bridge UI remains
Chinese.

## Automated evidence

- Commit `1255ec1` passed the complete [CI run
  33035459588](https://github.com/chenrgSix/AgentRoom/actions/runs/33035459588).
  Its native `windows-latest` job compiled the installer with Inno Setup,
  validated the package metadata, installed silently at the default
  `%LOCALAPPDATA%` path, checked the payload, Start menu shortcut, HKCU
  uninstall registration, and injected version, performed a same-version
  in-place upgrade, and then uninstalled it.
- The lifecycle smoke test writes an owner-state sentinel below
  `%APPDATA%\agentroom` before installation and verifies that both upgrade and
  uninstall preserve it. It refuses to run if the default installation,
  registration, shortcut, or sentinel already exists, so it cannot silently
  replace a developer's installation.
- The same run passed the repository production builds, workspace tests,
  deterministic end-to-end tests, schema validation, documentation lint,
  Compose validation, all Go tests and vet, and the native macOS desktop job.
- The downloaded CI artifacts were independently inspected. The portable ZIP
  contains the amd64 `PE32+` GUI executable, README, `LICENSE`, `NOTICE`, and
  `COMMERCIAL-LICENSE.md`; its SHA-256 is
  `56c02e5d0d8f68fa836977947d7766d6a91ebe3d71a61f52c120e089b988317e`.
  The installer is a Windows GUI PE containing `AgentRoom Bridge` and
  `0.0.0-ci` metadata; its SHA-256 is
  `5c8df9b821d8f158a43e519ed1357c0f0f6972901f97e71fb278987a981521f6`.
- The Bridge Release workflow now builds and lifecycle-tests the Windows
  installer, uploads both Windows desktop formats, includes the installer in
  `SHA256SUMS`, and requires a strict 13-asset set. The release verifier retains
  every existing checksum, archive path, architecture, embedded version, and
  license check and adds Windows installer PE, product-name, and version checks.

## Release gate result

`v0.3.0-rc.3` closes the remaining release gate. [Release run
33036272429](https://github.com/chenrgSix/AgentRoom/actions/runs/33036272429)
built and lifecycle-tested the installer, verified the complete 13-asset set
before and after upload, and published it as a prerelease. A fresh public
download passed independent Linux and macOS verification. Full evidence is in
`docs/acceptance/qa-024-v0.3.0-rc.3.md`.

The native automation also does not claim a human-observed SmartScreen prompt,
interactive wizard layout, running-application close prompt, or missing-WebView2
dialog. Code signing, automatic updates, Windows login startup, and bundling the
WebView2 Runtime remain outside this task.
