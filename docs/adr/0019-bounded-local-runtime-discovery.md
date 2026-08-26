# ADR-0019: Discover Runtime executables without shell startup

- Status: Accepted
- Date: 2026-08-26
- Supersedes: none

## Decision

Desktop launch environments do not necessarily inherit the terminal's PATH.
Console discovery first checks PATH, then a bounded set of common local
installation locations, including macOS ChatGPT/Codex app resources, Homebrew,
user-local bins, and installed nvm Node versions. Relative candidates and
non-executable or special files are not selected. Discovery never evaluates
shell profiles, recursively scans a home directory, executes a candidate,
installs software, or changes Runtime configuration.

Keep the existing detected-path state fields for compatibility and add a
local-only source projection. An authenticated explicit
`GET /api/runtime-discovery` refreshes discovery; ordinary state polling does
not rescan installations. The GUI displays the result and instructions for
locating an executable, not a containing directory. A missing result never
clears an existing draft. Applying a successful result only edits the local
draft; saving and Runtime preflight retain their existing authority fences.

## Verification

Fixtures cover missing PATH, bundled apps, common bins, numeric nvm version
ordering, invalid candidates, explicit refresh authentication, no config or
lifecycle changes, and missing-result draft preservation. An isolated browser
checks both detected and missing states. Native shell compilation is separate
from installed-app acceptance.
