# BRG-060: Windows product icons

- Date: 2026-08-31
- Baseline: `45097e4`
- Scope: Windows desktop presentation resources and packaging checks
- Result: local regression and actual PE-resource acceptance passed;
  Windows Shell and installer execution remain separate native CI gates

## Cause and repair

An isolated copy of the baseline was cross-built with the desktop production
tags and Windows GUI linker flag. Its PE Resource Directory had zero RVA and
size, and no `.rsrc` section. The packaging script built the executable without
an icon resource object. Shortcuts, protocol registration and the uninstall
display entry pointed back to that resource-free executable. The installer also
omitted `SetupIconFile`, leaving Inno Setup's default icon rather than the
product mark. Inno documents that this setting controls both setup and uninstall
program icons. See [SetupIconFile](https://jrsoftware.org/ishelp/topic_setup_setupiconfile.htm).

The existing `site/public/mark.svg` now produces a 256px embedded PNG, an ICO
with 16/24/32/48/64/128/256px images, and a deterministic Windows amd64 resource
object. Small ICO frames use 32-bit DIB data and transparency masks; the 256px
frame is PNG. The checked-in architecture-specific object makes ordinary Go
desktop builds include the icon, without a manual packaging prerequisite.

Wails beta.12 loads icon group 3 for its WebView and resource 32512 for its
window class. Both groups reference the same seven image resources, with group
3 retaining index zero. Windows application and tray PNGs use the same mark;
macOS and Linux defaults are unchanged. No manifest, privileges, version
metadata, runtime configuration or installer data ownership was changed.

The isolated `bridge/tools/windows-resources` module pins its build-time
dependencies; they are not added to the Bridge runtime. It verifies generated
assets and parses the actual PE resource tree, rejecting missing, corrupt,
different or additional icon resources. The converter preserves SVG rectangle
radius defaults, compact arc flags and scaled stroke widths. Visual inspection
and geometry tests caught and corrected the pinned renderer's initial loss of
rounded corners, the C-shaped arc and stroke scale; the source SVG was not
modified or replaced with different artwork.

Packaging checks resources before building, verifies the resulting executable
before archiving, and passes the same ICO to Inno Setup. Shortcuts explicitly
select executable icon index zero. Native Windows gates compare extracted
large/small icon pixels, reject resource-free and wrong-brand fixtures, and
inspect installed shortcut targets. They use
[ExtractIconExW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-extracticonexw),
not an associated-icon lookup that could return a generic system fallback.
Both CI and Release Windows jobs execute these checks before distribution.

## Executed verification

Local commands ran on macOS 26.6.2 arm64 with Go 1.26.7 and Node 22.23.1.
Dependencies, binaries and fixtures used task-owned temporary paths.

| Gate | Result |
| --- | --- |
| Actual baseline Windows desktop EXE | Rejected: missing icon resource directory |
| Rebuilt Windows desktop EXE | Pass: `.rsrc` present, both icon groups and all seven images match the product mark |
| Resource tool tests and race | 9 tests pass, including real cross-built PE positives and negatives |
| Resource tool vet and deterministic `-mode check` | Pass |
| Embedded PNG geometry/alpha/brand-color test | Pass, including race |
| Complete desktop-tag suite and race | Pass; Windows-only test functions are not executed on this host |
| Full Bridge `go test ./...` and `go vet ./...` | Pass |
| Native macOS desktop build | Pass; existing SDK deployment-target warnings |
| Windows desktop build, test cross-compilation and cross-vet | Pass |
| `npm run test:bridge-ui` | 48 pass |
| `npm run test:qa-evidence` | 37 pass, including five new packaging-policy tests |
| Documentation lint and patch whitespace | Pass |

Independent review checked the Wails resource IDs, shared image references,
index ordering, PE bounds, generated visual geometry, PowerShell handle
ownership and CI invocation. The corrected PNG was actually viewed, rather
than accepted only because it decoded successfully.

## Delivery boundary

No Windows host, PowerShell, Inno compiler or installed Windows UI was available
locally. Native extraction, setup/uninstall and actual Explorer/title-bar/tray
appearance are wired into Windows CI, not reported here as executed. No CI run,
Release, installer or user installation was published or changed in this task.
The local EXEs are diagnostic artifacts, not released packages. Existing
installed versions need a newly built executable or installer to gain the icon;
the optional desktop shortcut remains unchecked by default.

After confirming no open files or native socket fixtures remained, the
approximately 937-MB task-owned baseline source, Go caches, logs and diagnostic
binaries were removed. They are reproducible from the committed checks. No user
configuration, credential, installed application, shared cache or
operating-system icon cache was modified.
