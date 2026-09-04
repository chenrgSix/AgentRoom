# SITE-004 v0.5.0-rc.4 Public Version Copy

Date: 2026-09-04

Status: accepted. The goal was frozen after the prerelease became public and
before changing the README or product-site source. Delivery state lives only
in `docs/TASKS.md`.

## Goal

Identify the already published `v0.5.0-rc.4` as the current prerelease in the
README, product home page and getting-started guide while preserving
`v0.4.2` as stable Latest.

The public copy must explain in ordinary language that Bridge/Desktop works on
macOS, Windows and Linux, and that a browser on another computer may need to
trust a private Central CA regardless of that computer's operating system. It
must not imply that Windows is the only supported client or silently promise a
zero-install private-CA experience.

## Scope

- update only current-prerelease links and explanatory copy in `README.md` and
  `site/src/`;
- update the existing static release-boundary regression to require rc.4 and
  reject stale rc.3 links;
- preserve the Client-owned repository/Git boundary, stable Latest, licensing,
  provider, backup, unsigned-package and physical-platform limits; and
- build the static site, deploy it through the existing Pages workflow, then
  compare every public file with the exact local build from the deployed
  source revision.

No application binary, Release asset, tag, Central deployment, credential,
trust store or Git repository is changed by this task.

## Acceptance

1. `npm run test:site`, `npm run build:site`, `npm run lint:docs` and
   `git diff --check -- README.md site docs` pass.
2. README, home and guide name `v0.5.0-rc.4` as the current prerelease and link
   to its public immutable Release.
3. Home and guide still name `v0.4.2` as stable Latest.
4. The guide states the cross-platform private-browser trust boundary without
   claiming automatic trust installation.
5. The Pages workflow publishes the exact source commit and every deployed
   file matches the exact locally built bytes.

## Acceptance Evidence

README, home and guide now identify the public `v0.5.0-rc.4` prerelease, retain
`v0.4.2` as stable Latest and explain that Windows, macOS and Linux clients may
all need an explicit private-CA browser trust step on another computer. The
copy promises no silent trust-store mutation, signed package or automatic
update.

All 15 static tests passed before and after commit, the exact-commit static
build recorded source
`811bc0f1e9f9c4c626978ce8a11c2e0a8b3ebfe8`, the 369-file documentation gate
reported zero findings and whitespace checks passed. Product Website run
[33838982972](https://github.com/chenrgSix/ConveneWire/actions/runs/33838982972)
built and deployed that exact source.

Independent HTTPS downloads of home, guide, custom 404, guide JavaScript,
product mark, CSS, robots, sitemap and version metadata matched all nine local
build files byte for byte on the first comparison round. Public
`version.json` named the same full source revision. The task-owned comparison
root was physically removed and the four historical-prefix snapshots in both
inspected temporary locations were unchanged.

Post-copy CI run
[33838983102](https://github.com/chenrgSix/ConveneWire/actions/runs/33838983102)
passed Repository, native macOS Desktop and native Windows Desktop on its first
attempt. Its first Go attempt recorded one contention-sensitive one-second
client-shutdown timeout in
`TestCanceledRunReplaysDurableTerminalStatusAfterFirstWriteIsLost`; the exact
test then passed 100 consecutive isolated local executions, its owned cache
root disappeared, and the failed-only Go rerun passed the complete Go gate in
2 minutes 17 seconds. No production or test source was changed to conceal the
original result.
