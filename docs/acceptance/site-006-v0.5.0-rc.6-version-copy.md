# SITE-006 v0.5.0-rc.6 Public Version Copy

Date: 2026-09-05

Status: implementation complete; exact-source Pages and independent public
byte comparison remain open. Delivery state lives only in `docs/TASKS.md`.

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

## Pending Evidence

The public-copy implementation and local checks must be committed before an
exact-source Pages run can exist. Record that run and the independent byte
comparison here before marking `SITE-006` done.
