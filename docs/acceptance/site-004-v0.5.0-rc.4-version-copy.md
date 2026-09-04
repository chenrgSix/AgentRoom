# SITE-004 v0.5.0-rc.4 Public Version Copy

Date: 2026-09-04

Status: goal frozen after the prerelease became public and before changing the
README or product-site source. Delivery state lives only in `docs/TASKS.md`.

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
