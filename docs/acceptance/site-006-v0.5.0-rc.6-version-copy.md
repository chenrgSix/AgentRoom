# SITE-006 v0.5.0-rc.6 Public Version Copy

Date: 2026-09-05

Status: accepted. The goal was frozen before changing public copy. Delivery
state lives only in `docs/TASKS.md`.

## Goal

After `v0.5.0-rc.6` is publicly verified, identify it as the current
prerelease in README, product home and getting-started guide while preserving
`v0.4.2` as stable Latest.

The copy must explain the streamlined 12-asset distribution and the single
source-build Central package without telling stable v0.4.2 users to apply the
new package shape to their historical Release. It must name the Discussion
progress-integrity change without implying broader Agent or scheduling
authority.

## Scope And Acceptance

- update current-prerelease links and explanatory copy in `README.md` and
  `site/src/` only after the Release is public;
- describe the rc.6 Central source archive, external checksum pin, supported
  controller hosts and target-side Docker Compose build;
- update static release-boundary tests to require rc.6 and reject stale rc.5,
  rc.4 and rc.3 links;
- preserve stable Latest, Client-owned Git, licensing, backup, unsigned-package,
  private-browser trust and physical-platform boundaries;
- pass site tests/build, docs lint and whitespace checks; and
- verify the Pages run used the exact source commit and every deployed public
  file matches its exact local build bytes.

No application binary, Release asset, tag, Central deployment, credential,
trust store or repository authority is changed by this task.

## Acceptance Evidence

README, home and guide identify the already public `v0.5.0-rc.6` prerelease,
retain `v0.4.2` as stable Latest and explain the streamlined 12-asset set. The
guide directs rc.6 users to the one host-neutral Central source archive and its
checksum pin, target-side Docker Compose build and supported Linux or
Apple-silicon controller host. It separately warns stable v0.4.2 users to
follow that historical Release instead of applying the new package shape.

All 15 static tests passed, the exact-commit site build recorded source
`3eb7a5491b78380f7f4ea97b882d6c7e003578e9`, the 382-file documentation gate
reported zero findings and whitespace checks passed. Browser QA at 1280-pixel
desktop and 390-pixel mobile widths found no horizontal overflow, no stale rc.5
copy and readable version and Central-install sections.

Product Website run
[33942185816](https://github.com/chenrgSix/ConveneWire/actions/runs/33942185816)
built and deployed that exact source. Its only annotations were GitHub's
non-failing notice that pinned first-party Pages actions still target Node.js
20 and were forced by the platform to Node.js 24; both build and deployment
jobs passed.

Independent credential-free HTTPS downloads of home, guide, custom 404, guide
JavaScript, product mark, CSS, robots, sitemap and version metadata matched all
nine local build files byte for byte. Public `version.json` named the same full
source revision. The task-owned comparison root was physically removed after
verification.

Post-copy CI run
[33942185751](https://github.com/chenrgSix/ConveneWire/actions/runs/33942185751)
passed Repository, Go, native macOS Desktop and native Windows Desktop for the
same exact source on its first attempt.
